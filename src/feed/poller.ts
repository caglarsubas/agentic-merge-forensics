/**
 * One poll cycle: the only place in the feed that does I/O and the only place
 * the pure modules meet.
 *
 * The shape is deliberate. One cheap call lists every repo the account can see
 * with its `pushed_at`, which is enough to decide that most of the watchlist has
 * not changed and can be skipped entirely. Only the survivors cost the two `gh`
 * calls that actually hurt — each one is 3-8 seconds of wall clock, dominated by
 * process startup, so the cost model here is subprocess count and nothing else.
 *
 * Writes are ordered so that a crash cannot lose events: append first, advance
 * the watermark second. Re-running a cycle therefore re-derives events that were
 * already recorded, which is safe because event ids are derived from the facts
 * rather than a counter, and `dedupe` drops them. The opposite order would be
 * fast and would silently lose whatever happened in the window.
 */
import { mapLimit } from "../engine/exec";
import { listAccessibleRepos } from "../engine/github";
import {
  appendEvents,
  readCycleStatus,
  readFeedIndex,
  readRecentEvents,
  readRepoWatermarks,
  readWatchlist,
  writeCycleStatus,
  writeFeedIndex,
  writeRepoWatermark,
  FEED_INDEX_LIMIT,
} from "../store/feed-store";
import { dedupe, diffPrs, prSnapshotFrom, pushEvents, pushSnapshotFrom } from "./events";
import { defaultBranchOf, listRepoPrs, listTrunkCommits, repoRateRemaining } from "./github-feed";
import { backoffFor, planCycle, DEFAULT_BACKOFF_BASE_MS, DEFAULT_CAP } from "./plan";
import type { CycleStatus, FeedEvent, PrSnapshot, RepoWatermark } from "./types";

/** Repos hydrated at once. Four keeps a cycle bounded without a thundering herd
 *  of gh processes; it matches the per-PR cap the analysis engine already uses. */
const HYDRATE_CONCURRENCY = 4;

/** Below this many core requests left, the cycle does less rather than stopping:
 *  a feed that goes dark is indistinguishable from a broken one. */
const RATE_FLOOR = 500;

export interface CycleOptions {
  cap?: number;
  /** Events kept in memory for the duplicate check. */
  dedupeWindow?: number;
}

interface Hydrated {
  slug: string;
  prs: PrSnapshot[];
  events: FeedEvent[];
  lastCommitSha: string | null;
  defaultBranch: string | null;
  error: string | null;
}

function markFor(
  marks: Record<string, RepoWatermark>,
  slug: string,
): RepoWatermark | undefined {
  return marks[slug];
}

function emptyStatus(cycle: number, startedAt: string, now: Date): CycleStatus {
  return {
    cycle,
    startedAt,
    finishedAt: now.toISOString(),
    durationMs: 0,
    polled: [],
    skipped: 0,
    deferred: 0,
    newEvents: 0,
    errors: [],
    throttled: false,
    rateRemaining: null,
  };
}

/**
 * Hydrate one repo: its pull requests, and whatever landed on the trunk outside
 * one. Failures are returned rather than thrown — `mapLimit` has no error
 * isolation, so a single rejection would take the whole cycle with it.
 */
async function hydrate(
  slug: string,
  mark: RepoWatermark | undefined,
  previousPrs: readonly PrSnapshot[],
  now: Date,
  observedAt: string,
): Promise<Hydrated> {
  const result: Hydrated = {
    slug,
    prs: [],
    events: [],
    lastCommitSha: mark?.lastCommitSha ?? null,
    defaultBranch: mark?.defaultBranch ?? null,
    error: null,
  };

  const listed = await listRepoPrs(slug);
  if (listed.error) {
    result.error = listed.error;
    return result;
  }
  result.prs = listed.prs.map((raw) => prSnapshotFrom(slug, raw, now));

  // A repo seen for the first time is baselined rather than replayed, so adding
  // a busy repo does not announce forty old pull requests as breaking news.
  const known = previousPrs.filter((pr) => pr.repo === slug);
  result.events.push(...diffPrs([...known], result.prs, observedAt));

  // The trunk. `pushed_at` moving without a PR to explain it is the direct-push
  // case this tool exists to notice.
  if (!result.defaultBranch) {
    result.defaultBranch = await defaultBranchOf(slug);
  }
  const commits = await listTrunkCommits(slug, result.defaultBranch, mark?.lastPolledAt ?? null);
  if (commits.error) {
    // Not fatal: the PR half of this repo succeeded and is worth keeping.
    result.error = commits.error;
    return result;
  }
  const pushes = commits.commits.map((raw) => pushSnapshotFrom(slug, raw, now));
  result.events.push(...pushEvents(mark?.lastCommitSha ?? null, pushes, observedAt));
  if (pushes.length > 0) result.lastCommitSha = pushes[0].sha;

  return result;
}

/** Run one cycle. Returns what it did, which is also what the UI displays. */
export async function runCycle(options: CycleOptions = {}): Promise<CycleStatus> {
  const started = new Date();
  const startedAt = started.toISOString();
  const observedAt = startedAt;
  const cycle = (readCycleStatus()?.cycle ?? 0) + 1;

  const watchlist = readWatchlist();
  if (watchlist.length === 0) {
    const status = emptyStatus(cycle, startedAt, new Date());
    writeCycleStatus(status);
    return status;
  }

  // One call covers the whole watchlist, however long it is. Everything after
  // this point is proportional to what actually changed.
  const listing = await listAccessibleRepos();
  const pushedAt: Record<string, string | null> = {};
  for (const repo of listing.repos) {
    pushedAt[repo.slug.toLowerCase()] = repo.pushedAt;
  }

  const rateRemaining = await repoRateRemaining();
  const throttled = rateRemaining !== null && rateRemaining < RATE_FLOOR;
  const cap = throttled
    ? Math.max(2, Math.floor((options.cap ?? DEFAULT_CAP) / 3))
    : options.cap ?? DEFAULT_CAP;

  const watermarks = readRepoWatermarks();
  const index = readFeedIndex();
  const previousPrs = index?.prs ?? [];

  const plan = planCycle(
    { watchlist, watermarks, pushedAt, openPrs: previousPrs, cycle, cap },
    started,
  );

  const hydrated = await mapLimit(plan.poll, HYDRATE_CONCURRENCY, (planned) =>
    hydrate(planned.slug, markFor(watermarks, planned.slug), previousPrs, started, observedAt),
  );

  // Append before advancing any watermark. See the file header.
  const fresh = dedupe(readRecentEvents(options.dedupeWindow ?? 300), hydrated.flatMap((h) => h.events));
  if (fresh.length > 0) appendEvents(fresh);

  const errors: Array<{ slug: string; message: string }> = [];
  const polledSlugs = new Set<string>();
  for (const repo of hydrated) {
    polledSlugs.add(repo.slug);
    const previous = markFor(watermarks, repo.slug);
    const failures = repo.error ? (previous?.failures ?? 0) + 1 : 0;
    if (repo.error) errors.push({ slug: repo.slug, message: repo.error });

    writeRepoWatermark({
      slug: repo.slug,
      // Only claim to have caught up to `pushed_at` when nothing failed —
      // otherwise a transient error would look like a successfully quiet repo
      // and the change that triggered this poll would never be retried.
      pushedAt: repo.error
        ? previous?.pushedAt ?? null
        : pushedAt[repo.slug.toLowerCase()] ?? previous?.pushedAt ?? null,
      lastCommitSha: repo.lastCommitSha,
      lastPolledAt: repo.error ? previous?.lastPolledAt ?? null : startedAt,
      defaultBranch: repo.defaultBranch,
      failures,
      nextEligibleAt: repo.error
        ? new Date(started.getTime() + backoffFor(failures, DEFAULT_BACKOFF_BASE_MS)).toISOString()
        : null,
      lastError: repo.error,
    });
  }

  // The new observation: fresh snapshots for what was polled, carried forward
  // for what was not. Dropping the rest would make every unpolled repo look
  // unseen next cycle and suppress its events.
  const carried = previousPrs.filter((pr) => !polledSlugs.has(pr.repo));
  const nextPrs = [...hydrated.flatMap((h) => (h.error ? [] : h.prs)), ...carried];
  const carriedForFailed = previousPrs.filter(
    (pr) => polledSlugs.has(pr.repo) && hydrated.some((h) => h.slug === pr.repo && h.error),
  );

  writeFeedIndex({
    events: readRecentEvents(FEED_INDEX_LIMIT),
    prs: [...nextPrs, ...carriedForFailed],
    updatedAt: new Date().toISOString(),
  });

  const finished = new Date();
  const status: CycleStatus = {
    cycle,
    startedAt,
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    polled: plan.poll.map((planned) => planned.slug),
    skipped: plan.skipped.length,
    deferred: plan.deferred.length,
    newEvents: fresh.length,
    errors,
    throttled,
    rateRemaining,
  };
  writeCycleStatus(status);
  return status;
}
