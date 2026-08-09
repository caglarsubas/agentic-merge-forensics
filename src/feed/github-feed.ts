/**
 * The feed's `gh` calls, and nothing else.
 *
 * One fact shapes this whole file: a `gh` invocation costs 3-8 seconds of wall
 * clock, almost all of it process startup and network, while the core API quota
 * (5000/hr) is nowhere near the binding constraint. So the budget being spent
 * here is *subprocess count*, not requests and not CPU. Every function below is
 * exactly one invocation — no `gh auth status` preflight, no `--paginate` loop,
 * no per-PR follow-up call. A preflight would double the cost of a poll to
 * confirm something that the real call reports anyway.
 *
 * The consequence is that a failure has to be legible from the single call that
 * failed, which is why nothing here throws and every result carries the error
 * instead. The poller needs to write "this repo was unreachable this cycle" to a
 * watermark and keep going, the same way the analysis treats `gh` as optional
 * rather than required.
 *
 * The two endpoints are not interchangeable, and the feed needs both. `gh pr
 * list` hands back mergeability and check state for free, which is the only
 * reason the feed can report conflicts without cloning anything — but it carries
 * no commit bodies. `/repos/{slug}/commits` does, and a full commit message is
 * the only place a `Co-Authored-By` trailer is visible for a direct push, which
 * is the only attribution signal a push has once there is no branch name to read.
 */
import { run } from "../engine/exec";
import type { RawApiCommit, RawPr } from "./events";

/**
 * Everything the feed shows about a PR, in one query. `mergeable` and
 * `mergeStateStatus` cost nothing extra alongside `statusCheckRollup`, so the
 * conflict signal is free; it would not be worth a second call if it were not.
 */
const PR_FIELDS = [
  "number",
  "title",
  "author",
  "headRefName",
  "headRefOid",
  "createdAt",
  "updatedAt",
  "mergedAt",
  "closedAt",
  "state",
  "isDraft",
  "additions",
  "deletions",
  "changedFiles",
  "mergeable",
  "mergeStateStatus",
  "statusCheckRollup",
  "url",
].join(",");

/** A PR list on a busy repo is the slowest call here. Past this it is wedged,
 *  and a wedged `gh` holding the poller open is worse than a missed cycle. */
const LIST_TIMEOUT_MS = 45_000;

/** Single-object reads. Anything slower than this was never going to arrive. */
const POINT_TIMEOUT_MS = 15_000;

/** GitHub's `per_page` ceiling, and more than the feed would ever display. */
const MAX_PAGE = 100;

/** How far back a first poll looks. See coldStartSince below. */
const COLD_START_HOURS = 24;

/**
 * `owner/name` with each segment percent-encoded. Real slugs pass through
 * untouched — GitHub allows nothing that needs escaping — so this exists purely
 * so a hand-edited watchlist entry becomes a 404 from the API rather than extra
 * path segments inside the URL it was interpolated into.
 */
function slugPath(slug: string): string {
  return slug
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Keep a caller's `limit` inside what the API will actually honour. */
function pageSize(limit: number, max = MAX_PAGE): number {
  if (!Number.isFinite(limit)) return max;
  return Math.max(1, Math.min(Math.trunc(limit), max));
}

function parseJson<T>(stdout: string): T | null {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

/**
 * The message to record for a failed call.
 *
 * `run()` folds a timeout kill into an ordinary non-zero exit with empty
 * stderr, so silence is itself the signal and the fallback says so out loud —
 * "gh failed" with no reason attached is the kind of error that costs someone
 * an afternoon.
 */
function ghError(stderr: string, what: string): string {
  const message = stderr.trim();
  return message ? message.slice(0, 200) : `${what} failed with no output (timed out?)`;
}

/**
 * Every pull request the feed cares about for one repo, most recently updated
 * first.
 *
 * `--state all` rather than `open`: a merge or a close is exactly the event
 * worth reporting, and a PR that vanished from the open list would otherwise
 * just silently disappear from the feed.
 *
 * `--search sort:updated-desc` is not decoration. Measured on cli/cli: plain
 * `gh pr list --state all` comes back ordered by *creation* (strictly
 * descending PR number), so a PR opened weeks ago that just went red sits far
 * down the list and falls outside any sane `limit`. That is precisely the event
 * this feed exists to show, so ordering by creation would structurally hide it.
 * With the search qualifier the order is genuinely update-descending and the
 * list still contains OPEN, MERGED and CLOSED PRs with every field above.
 *
 * The cost is that this one call is served by the search API, whose quota is
 * 30/minute and separate from the 5000/hour core pool that the rest of this
 * file draws on — see repoRateRemaining. Search results can also lag reality by
 * a short interval, which for a watermarked poller means an event arrives a
 * cycle late rather than never. Late beats invisible.
 */
export async function listRepoPrs(
  slug: string,
  limit = 40,
): Promise<{ prs: RawPr[]; error?: string }> {
  // `--repo` takes an argv value, not a URL segment, and run() uses execFile
  // with no shell, so the slug goes through as the user wrote it.
  const result = await run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      slug,
      "--state",
      "all",
      "--search",
      "sort:updated-desc",
      "--limit",
      String(pageSize(limit)),
      "--json",
      PR_FIELDS,
    ],
    { timeoutMs: LIST_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    return { prs: [], error: ghError(result.stderr, "gh pr list") };
  }

  const raw = parseJson<RawPr[]>(result.stdout);
  if (!Array.isArray(raw)) {
    return { prs: [], error: "could not parse gh pr list output" };
  }
  return { prs: raw };
}

/**
 * Trunk commits since the watermark, newest first.
 *
 * This is the call that returns full commit messages, trailers included, which
 * is what makes a direct push attributable at all. `gh pr list` gives no commit
 * bodies, so there is no cheaper way to get them.
 *
 * Deliberately un-paginated: one page is the cap. A repo that landed more than
 * `limit` commits between two polls loses the oldest of them from the feed,
 * which is the right trade — the feed is a "what just happened" view, not an
 * audit log, and `analyze()` is where completeness lives.
 */
export async function listTrunkCommits(
  slug: string,
  branch: string | null,
  since: string | null,
  limit = 30,
): Promise<{ commits: RawApiCommit[]; error?: string }> {
  const query = new URLSearchParams();
  // No branch means no watermark for it either; let GitHub pick the default
  // rather than guess "main" and read the wrong history in silence.
  if (branch) query.set("sha", branch);
  query.set("since", since ?? coldStartSince());
  query.set("per_page", String(pageSize(limit)));

  const result = await run(
    "gh",
    [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `/repos/${slugPath(slug)}/commits?${query.toString()}`,
    ],
    { timeoutMs: LIST_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    return { commits: [], error: ghError(result.stderr, "gh api commits") };
  }

  const raw = parseJson<RawApiCommit[]>(result.stdout);
  if (!Array.isArray(raw)) {
    return { commits: [], error: "could not parse gh api commits output" };
  }
  return { commits: raw };
}

/**
 * The cutoff for a repo with no watermark yet.
 *
 * `/commits` with no `since` walks back to the repo's first commit, and the
 * page cap alone would not save us: it would just return the newest 30 commits,
 * which on a dormant repo are two years old and would be announced as things
 * that just happened. A window makes the first poll of a quiet repo correctly
 * boring.
 */
function coldStartSince(now: number = Date.now()): string {
  return new Date(now - COLD_START_HOURS * 3600_000).toISOString();
}

interface RateLimitResponse {
  resources?: { core?: { remaining?: number } };
  /** The older top-level alias; still present, and harmless to fall back to. */
  rate?: { remaining?: number };
}

/**
 * Core quota left this hour, or null if anything at all went wrong.
 *
 * Null rather than a throw or a zero: this reading only exists so the poller can
 * choose to do less, and a rate check that took the cycle down with it — or that
 * reported 0 on a parse error and stalled the feed indefinitely — would be worse
 * than having no rate check at all.
 *
 * The endpoint itself is not rate limited, so checking is free of the thing it
 * measures.
 *
 * Honest limitation: this is the *core* pool, which covers listTrunkCommits and
 * defaultBranchOf but not listRepoPrs, which is served by the search pool
 * (30/minute). A cycle can therefore be throttled by search while this number
 * still reads in the thousands. Core is reported because it is the one figure
 * CycleStatus has room for and the one that governs three of the four calls
 * here; a poller that fans out over more than ~30 repos a minute will hit the
 * search ceiling first and should treat its own concurrency as the real budget.
 */
export async function repoRateRemaining(): Promise<number | null> {
  const result = await run("gh", ["api", "rate_limit"], { timeoutMs: POINT_TIMEOUT_MS });
  if (result.code !== 0) return null;

  const raw = parseJson<RateLimitResponse>(result.stdout);
  const remaining = raw?.resources?.core?.remaining ?? raw?.rate?.remaining;
  return typeof remaining === "number" ? remaining : null;
}

/**
 * The repo's default branch, or null if it could not be read.
 *
 * Called once per repo and then cached on the watermark, because it changes
 * about never. Null means "no answer this time", not "no default branch" — the
 * caller should keep whatever it already had rather than overwrite it.
 */
export async function defaultBranchOf(slug: string): Promise<string | null> {
  const result = await run(
    "gh",
    ["api", `/repos/${slugPath(slug)}`, "--jq", ".default_branch"],
    { timeoutMs: POINT_TIMEOUT_MS },
  );
  if (result.code !== 0) return null;

  const branch = result.stdout.trim();
  // `--jq` prints a literal "null" for a missing field, which is not a branch.
  return branch && branch !== "null" ? branch : null;
}
