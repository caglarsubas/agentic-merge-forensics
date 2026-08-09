/**
 * Deriving events from two observations of the same repository.
 *
 * GitHub answers "what is true now"; the feed asks "what changed". The only
 * bridge is to diff the current read against the previous one, and every
 * awkward decision here falls out of that:
 *
 *   - A repo with no previous observation has nothing to diff against, so its
 *     current state becomes the baseline and produces no events. The
 *     alternative — treating every PR already open as newly opened — turns
 *     adding a busy repo to the watchlist into forty "pr-opened" entries for
 *     things that happened weeks ago. The baseline is decided per repo, not
 *     per call, because the watchlist grows one repo at a time.
 *   - "unknown" is not a value, it is GitHub still thinking. Mergeability is
 *     computed lazily, so clean → unknown → conflicting is one change seen
 *     three times, not two changes. Transitions touching "unknown" are skipped.
 *   - Ids come from the facts, never from the cycle, so a poll that re-reads a
 *     state it already reported derives the same id and `dedupe` drops it
 *     rather than the feed saying it twice.
 *
 * Everything here is pure: no clock, no subprocess, no disk. `now` is passed in
 * and is only ever used to fill a timestamp GitHub omitted.
 */
import { DEFAULT_CODER_RULES, detectCoder } from "../engine/coder";
import type { CoderRule, CoderSignals } from "../engine/coder";
import type {
  CiState,
  CoderSource,
  ConflictState,
  FeedEvent,
  FeedEventKind,
  PrSnapshot,
  PrState,
  PushSnapshot,
} from "./types";

/**
 * One entry of `statusCheckRollup`. It is a union in GraphQL and gh flattens it
 * without discriminating for us: CheckRun reports status/conclusion, the older
 * StatusContext reports only state.
 */
export interface RawCheck {
  __typename?: string;
  name?: string;
  workflowName?: string;
  /** CheckRun: QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING. */
  status?: string;
  /** CheckRun, once it has finished. */
  conclusion?: string;
  /** StatusContext: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED. */
  state?: string;
  startedAt?: string;
  completedAt?: string;
  detailsUrl?: string;
}

/**
 * One row of `gh pr list --state all --json ...`.
 *
 * This doubles as the --json field list the poller has to ask for, and all of
 * it comes back in that one call — which matters, because each `gh` invocation
 * costs seconds, so the budget is subprocess count and there is no cheaper
 * second read to fall back on.
 */
export interface RawPr {
  number: number;
  title?: string;
  author?: { login?: string } | null;
  headRefName?: string;
  headRefOid?: string;
  isDraft?: boolean;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  /**
   * OPEN | MERGED | CLOSED. Deliberately unused: the timestamps decide, because
   * a PR is both merged and closed and only their order says which came first.
   */
  state?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable?: string;
  /** CLEAN | DIRTY | BLOCKED | BEHIND | UNSTABLE | UNKNOWN. */
  mergeStateStatus?: string;
  /** gh emits null, not [], when a repo has no checks configured. */
  statusCheckRollup?: RawCheck[] | null;
  url?: string;
}

/** One row of `gh api /repos/<slug>/commits?sha=<branch>&since=<iso>`. */
export interface RawApiCommit {
  sha: string;
  /** Full message, trailers included — the PR path never gets this. */
  commit?: {
    message?: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { name?: string; email?: string; date?: string };
  };
  /** Null when the commit email matches no GitHub account. */
  author?: { login?: string } | null;
  html_url?: string;
}

/** The facts an id is built from. A FeedEvent carries no sha, so this adds it. */
export interface EventFacts {
  kind: FeedEventKind;
  repo: string;
  /** Null for pushes, which have no PR number. */
  number: number | null;
  /** The PR's head sha, or the commit's own sha for a push. */
  sha: string;
}

/** Kept verbatim from src/engine/github.ts so both paths agree on "failing". */
const FAILING_VERDICTS = new Set(["FAILURE", "ERROR", "TIMED_OUT"]);

/**
 * Lifecycle events are identified by the PR number alone; everything else by
 * the head sha. See eventId for why the two halves differ.
 */
const LIFECYCLE_KINDS = new Set<FeedEventKind>([
  "pr-opened",
  "pr-merged",
  "pr-closed",
  "pr-reopened",
]);

/** gh emits Go's zero time rather than null for an unset timestamp. */
function timestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.startsWith("0001-01-01") ? null : value;
}

function conflictFrom(mergeable: string | undefined): ConflictState {
  switch ((mergeable ?? "").toUpperCase()) {
    case "MERGEABLE":
      return "clean";
    case "CONFLICTING":
      return "conflicting";
    default:
      // UNKNOWN, absent, or a value GitHub adds later: all mean "not told yet",
      // and none of them is evidence that the branch merges cleanly.
      return "unknown";
  }
}

/**
 * A check that has not finished. CheckRun says so through `status`; a
 * StatusContext has no status at all, only PENDING/EXPECTED in `state`.
 */
function isRunning(check: RawCheck): boolean {
  const status = (check.status ?? "").toUpperCase();
  if (status) return status !== "COMPLETED";
  const state = (check.state ?? "").toUpperCase();
  return state === "PENDING" || state === "EXPECTED";
}

interface CiRollup {
  ci: CiState;
  ciFailing: number;
  ciTotal: number;
}

function rollupCi(checks: readonly RawCheck[]): CiRollup {
  if (checks.length === 0) return { ci: "none", ciFailing: 0, ciTotal: 0 };

  let failing = 0;
  let running = 0;
  for (const check of checks) {
    const verdict = (check.conclusion || check.state || "").toUpperCase();
    // CANCELLED and ACTION_REQUIRED are deliberately not failures here: the
    // analysis engine has never counted them and a feed that disagreed with the
    // report about which PRs are red would be worse than one that under-counts.
    if (FAILING_VERDICTS.has(verdict)) {
      failing++;
      continue;
    }
    if (isRunning(check)) running++;
  }

  // A failure already observed stays a failure while the rest of the suite
  // finishes; waiting for the stragglers does not un-fail it.
  const ci: CiState = failing > 0 ? "failing" : running > 0 ? "pending" : "passing";
  return { ci, ciFailing: failing, ciTotal: checks.length };
}

function trailerText(messages: readonly string[]): string {
  return messages
    .join("\n")
    .toLowerCase()
    .split("\n")
    .filter((line) => /^(co-authored-by|signed-off-by|generated-by):/i.test(line.trim()))
    .join("\n");
}

/**
 * Which tier named the coder.
 *
 * detectCoder returns a label and nothing else, so this walks the same
 * precedence a second time rather than changing that contract. The tiers are
 * the ones its own header documents: branch prefix, bot login, commit trailer,
 * then the plain login as the fallback. If the two ever drift the label stays
 * correct and only the confidence badge goes stale, which is the cheaper half
 * to get wrong.
 */
function coderSourceOf(signals: CoderSignals, rules: readonly CoderRule[]): CoderSource {
  const head = (signals.headRefName ?? "").toLowerCase();
  const slash = head.indexOf("/");
  const prefix = slash === -1 ? "" : head.slice(0, slash);
  if (prefix && rules.some((rule) => rule.branchPrefixes?.some((p) => p.toLowerCase() === prefix))) {
    return "branch";
  }

  const login = (signals.authorLogin ?? "").toLowerCase();
  if (login && rules.some((rule) => rule.authorLogins?.some((a) => a.toLowerCase() === login))) {
    return "login";
  }

  const trailers = trailerText(signals.commitMessages ?? []);
  if (
    trailers &&
    rules.some((rule) => rule.trailerPatterns?.some((p) => trailers.includes(p.toLowerCase())))
  ) {
    return "trailer";
  }

  return "fallback";
}

function attribute(
  signals: CoderSignals,
  rules: readonly CoderRule[],
): { coder: string; coderSource: CoderSource } {
  return { coder: detectCoder(signals, rules), coderSource: coderSourceOf(signals, rules) };
}

/**
 * Normalise one `gh pr list` row.
 *
 * `gh pr list` returns no commit bodies at any price, so the trailer tier can
 * never fire here: a PR on an unprefixed branch is attributed to its author
 * even when every commit carries Co-Authored-By. Buying the trailers back would
 * cost one `gh pr view` per PR, which is seconds each. The push path below sees
 * them for free and does use them.
 */
export function prSnapshotFrom(
  repo: string,
  raw: RawPr,
  now: Date,
  rules: readonly CoderRule[] = DEFAULT_CODER_RULES,
): PrSnapshot {
  const stamp = now.toISOString();
  const headRefName = raw.headRefName ?? "";
  const authorLogin = raw.author?.login ?? "";
  const { coder, coderSource } = attribute({ headRefName, authorLogin }, rules);
  const { ci, ciFailing, ciTotal } = rollupCi(raw.statusCheckRollup ?? []);

  const mergedAt = timestamp(raw.mergedAt);
  const closedAt = timestamp(raw.closedAt);
  // A merged PR is also a closed one, so mergedAt has to be read first.
  const state: PrState = mergedAt ? "merged" : closedAt ? "closed" : "open";

  return {
    repo,
    number: raw.number,
    title: raw.title ?? "",
    authorLogin,
    headRefName,
    coder,
    coderSource,
    state,
    isDraft: Boolean(raw.isDraft),
    createdAt: timestamp(raw.createdAt) ?? stamp,
    updatedAt: timestamp(raw.updatedAt) ?? stamp,
    mergedAt,
    headSha: raw.headRefOid ?? "",
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    conflict: conflictFrom(raw.mergeable),
    mergeStateStatus: (raw.mergeStateStatus ?? "UNKNOWN").toUpperCase(),
    ci,
    ciFailing,
    ciTotal,
    url: raw.url || `https://github.com/${repo}/pull/${raw.number}`,
  };
}

/** Normalise one commits-API row. Here the full message is present. */
export function pushSnapshotFrom(
  repo: string,
  raw: RawApiCommit,
  now: Date,
  rules: readonly CoderRule[] = DEFAULT_CODER_RULES,
): PushSnapshot {
  const message = raw.commit?.message ?? "";
  const authorLogin = raw.author?.login ?? "";
  // No branch name is available per commit, so the branch tier cannot fire and
  // the trailer is the strongest signal a direct push ever has.
  const { coder, coderSource } = attribute({ authorLogin, commitMessages: [message] }, rules);

  return {
    repo,
    sha: raw.sha,
    subject: message.split("\n")[0] ?? "",
    authorLogin,
    coder,
    coderSource,
    // The committer date, not the author date: a rebased commit was authored
    // long before it landed, and the feed is about landing.
    committedAt:
      timestamp(raw.commit?.committer?.date) ??
      timestamp(raw.commit?.author?.date) ??
      now.toISOString(),
    url: raw.html_url || `https://github.com/${repo}/commit/${raw.sha}`,
  };
}

/**
 * A stable id for one logical event.
 *
 * Lifecycle events key on the PR number alone: a PR opens once and merges once,
 * so re-deriving them after a push must still land on the same id. The churnier
 * kinds recur over a PR's life, and the head sha is the only thing in the
 * snapshot that tells one occurrence from the next.
 *
 * The cost is at the edges: a conflict that appears, clears and reappears
 * without any push collapses into one event, and a PR closed, reopened and
 * closed again logs one pr-closed. Both are rarer than an overlapping poll, and
 * a feed that repeats itself is a worse failure than one that under-counts.
 */
export function eventId(event: EventFacts): string {
  if (event.kind === "push") return `${event.repo}#push:${event.sha}`;
  const fact = LIFECYCLE_KINDS.has(event.kind) ? "" : `:${event.sha}`;
  return `${event.repo}#${event.number}:${event.kind}${fact}`;
}

function churn(pr: PrSnapshot): string {
  return `+${pr.additions} −${pr.deletions}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function prEvent(
  kind: FeedEventKind,
  pr: PrSnapshot,
  at: string,
  detail: string,
  observedAt: string,
): FeedEvent {
  return {
    id: eventId({ kind, repo: pr.repo, number: pr.number, sha: pr.headSha }),
    kind,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    coder: pr.coder,
    coderSource: pr.coderSource,
    at,
    observedAt,
    // State as of the observation, which for a PR that opened and merged
    // between two polls is already "merged" on its own pr-opened event.
    state: pr.state,
    conflict: pr.conflict,
    ci: pr.ci,
    ciFailing: pr.ciFailing,
    detail,
    url: pr.url,
  };
}

function lifecycleEvent(pr: PrSnapshot, observedAt: string): FeedEvent {
  if (pr.state === "merged") {
    return prEvent(
      "pr-merged",
      pr,
      pr.mergedAt ?? pr.updatedAt,
      `${churn(pr)} across ${plural(pr.changedFiles, "file")}`,
      observedAt,
    );
  }
  if (pr.state === "closed") {
    return prEvent("pr-closed", pr, pr.updatedAt, "closed without merging", observedAt);
  }
  return prEvent("pr-reopened", pr, pr.updatedAt, "reopened", observedAt);
}

function eventsForPr(
  before: PrSnapshot | undefined,
  after: PrSnapshot,
  observedAt: string,
): FeedEvent[] {
  const events: FeedEvent[] = [];

  if (!before) {
    events.push(
      prEvent(
        "pr-opened",
        after,
        after.createdAt,
        after.isDraft ? `draft · ${churn(after)}` : churn(after),
        observedAt,
      ),
    );
    // A PR that opened and finished inside one polling interval still gets to
    // tell the whole story. Its conflict and CI state ride on the events above
    // rather than becoming transitions of their own: there is no earlier
    // observation for them to be a change from.
    if (after.state !== "open") events.push(lifecycleEvent(after, observedAt));
    return events;
  }

  // Ordered oldest-intent-first: checks flip, then mergeability recomputes,
  // then somebody acts on the result.
  if (after.ci === "failing" && before.ci !== "failing") {
    events.push(
      prEvent(
        "ci-failed",
        after,
        after.updatedAt,
        `${plural(after.ciFailing, "check")} failing`,
        observedAt,
      ),
    );
  } else if (before.ci === "failing" && after.ci === "passing") {
    // Only "passing" is a recovery. A re-run puts the suite back to "pending",
    // which is the start of another attempt rather than the end of the failure.
    events.push(
      prEvent(
        "ci-recovered",
        after,
        after.updatedAt,
        `all ${plural(after.ciTotal, "check")} passing`,
        observedAt,
      ),
    );
  }

  if (
    before.conflict !== "unknown" &&
    after.conflict !== "unknown" &&
    before.conflict !== after.conflict
  ) {
    const appeared = after.conflict === "conflicting";
    events.push(
      prEvent(
        appeared ? "conflict-appeared" : "conflict-cleared",
        after,
        after.updatedAt,
        `${appeared ? "conflicting" : "mergeable again"} · ${after.mergeStateStatus}`,
        observedAt,
      ),
    );
  }

  if (before.state !== after.state) events.push(lifecycleEvent(after, observedAt));

  // A new head sha with nothing else to say is a plain update. When something
  // else did change, that event already implies the push and saying both would
  // report one action twice.
  if (events.length === 0 && before.headSha !== after.headSha) {
    events.push(
      prEvent(
        "pr-updated",
        after,
        after.updatedAt,
        `head ${after.headSha.slice(0, 7)} · ${churn(after)}`,
        observedAt,
      ),
    );
  }

  return events;
}

function prKey(pr: PrSnapshot): string {
  return `${pr.repo}#${pr.number}`;
}

/**
 * Diff two observations into events.
 *
 * A repo that appears in `next` with no entry at all in `previous` is being
 * seen for the first time and produces nothing — see the header. The one event
 * that costs is the first PR ever opened in a repo that had none before, since
 * an empty `previous` for that repo is indistinguishable from an absent one.
 * Callers should hand back the list they stored last cycle (`gh pr list --state
 * all` includes merged and closed PRs), which keeps a repo present in
 * `previous` for as long as it has any PR history at all.
 *
 * PRs that were in `previous` and are missing from `next` produce nothing
 * either: the PR list is paginated, so falling off the end is not an event.
 */
export function diffPrs(
  previous: PrSnapshot[],
  next: PrSnapshot[],
  observedAt: string,
): FeedEvent[] {
  const before = new Map(previous.map((pr) => [prKey(pr), pr]));
  const knownRepos = new Set(previous.map((pr) => pr.repo));

  const events: FeedEvent[] = [];
  for (const pr of next) {
    if (!knownRepos.has(pr.repo)) continue;
    events.push(...eventsForPr(before.get(prKey(pr)), pr, observedAt));
  }
  return events;
}

/**
 * Commits newer than the watermark, oldest first.
 *
 * `commits` must be newest-first, which is how the commits API returns them —
 * "stop at the watermark" has no meaning otherwise. A null watermark is a first
 * sighting and yields nothing, for the same reason diffPrs does.
 *
 * When the watermark is not in the list at all — a force-push, or a gap longer
 * than the `since` window — every commit is emitted. That over-reports rather
 * than under-reports, and it is safe: a push id is derived from the commit sha,
 * so anything already in the feed is dropped by dedupe.
 */
export function pushEvents(
  previous: string | null,
  commits: PushSnapshot[],
  observedAt: string,
): FeedEvent[] {
  if (previous === null) return [];

  const fresh: PushSnapshot[] = [];
  for (const commit of commits) {
    if (commit.sha === previous) break;
    fresh.push(commit);
  }

  return fresh.reverse().map((commit) => ({
    id: eventId({ kind: "push", repo: commit.repo, number: null, sha: commit.sha }),
    kind: "push" as const,
    repo: commit.repo,
    number: null,
    title: commit.subject,
    coder: commit.coder,
    coderSource: commit.coderSource,
    at: commit.committedAt,
    observedAt,
    state: null,
    // A commit already on the trunk has no mergeability question left, and its
    // checks are not queried: one more `gh` call per commit is not worth it.
    conflict: "clean" as const,
    ci: "none" as const,
    ciFailing: 0,
    detail: `commit ${commit.sha.slice(0, 7)}`,
    url: commit.url,
  }));
}

/** Drop incoming events already in the feed, and repeats within one batch. */
export function dedupe(
  existing: readonly FeedEvent[],
  incoming: readonly FeedEvent[],
): FeedEvent[] {
  const seen = new Set(existing.map((event) => event.id));
  const kept: FeedEvent[] = [];
  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    kept.push(event);
  }
  return kept;
}
