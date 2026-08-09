/**
 * Shapes for the live activity feed.
 *
 * The feed is a second, much cheaper read path than `analyze()`: it answers
 * "what just happened across the repos I watch" rather than "what do 50 merges
 * tell me". It never clones and never blames, so everything here is derivable
 * from two `gh` calls per changed repo plus what the poller already knows.
 *
 * Two timestamps matter and they are not the same thing. `at` is when GitHub
 * says the thing happened; `observedAt` is when this machine first saw it. The
 * gap between them is polling latency, and showing arrival time honestly means
 * keeping both rather than pretending the poll was instantaneous.
 */

/** A repository the feed follows. */
export interface WatchEntry {
  /** `owner/name`, the form the whole engine already uses. */
  slug: string;
  addedAt: string;
  /** Kept in the list but skipped by the poller. */
  paused?: boolean;
}

export type PrState = "open" | "merged" | "closed";

/** Rolled up from statusCheckRollup; "none" means no checks are configured. */
export type CiState = "passing" | "failing" | "pending" | "none";

/**
 * GitHub's own mergeability verdict. "unknown" is load-bearing: GitHub computes
 * mergeability asynchronously and reports UNKNOWN while it is thinking, so a
 * feed that folded that into "clean" would quietly under-report conflicts.
 */
export type ConflictState = "clean" | "conflicting" | "unknown";

/** Which attribution tier named the coder, so the UI can show its confidence. */
export type CoderSource = "branch" | "trailer" | "login" | "fallback";

/** One pull request as the feed last saw it. */
export interface PrSnapshot {
  repo: string;
  number: number;
  title: string;
  authorLogin: string;
  headRefName: string;
  coder: string;
  coderSource: CoderSource;
  state: PrState;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  conflict: ConflictState;
  /** CLEAN | DIRTY | BLOCKED | BEHIND | UNSTABLE | UNKNOWN, verbatim. */
  mergeStateStatus: string;
  ci: CiState;
  ciFailing: number;
  ciTotal: number;
  url: string;
}

/** A commit that landed on the trunk outside a pull request. */
export interface PushSnapshot {
  repo: string;
  sha: string;
  subject: string;
  authorLogin: string;
  coder: string;
  coderSource: CoderSource;
  committedAt: string;
  url: string;
}

export type FeedEventKind =
  | "pr-opened"
  | "pr-updated"
  | "pr-merged"
  | "pr-closed"
  | "pr-reopened"
  | "ci-failed"
  | "ci-recovered"
  | "conflict-appeared"
  | "conflict-cleared"
  | "push";

/**
 * One thing that happened. Append-only and idempotent: `id` is derived from the
 * facts of the event, never from a counter or a clock, so a poll that overlaps
 * a previous one re-derives the same id and the event is dropped rather than
 * duplicated.
 */
export interface FeedEvent {
  id: string;
  kind: FeedEventKind;
  repo: string;
  /** Null for pushes, which have no PR number. */
  number: number | null;
  title: string;
  coder: string;
  coderSource: CoderSource;
  /** When GitHub says it happened. */
  at: string;
  /** When this machine first saw it. */
  observedAt: string;
  state: PrState | null;
  conflict: ConflictState;
  ci: CiState;
  ciFailing: number;
  /** Short human-readable specifics, e.g. "3 checks failing" or "+120 −4". */
  detail: string;
  url: string;
}

/** Per-repo poller state, persisted so a restart resumes rather than replays. */
export interface RepoWatermark {
  slug: string;
  /** GitHub's `pushed_at` at the last successful poll; the change detector. */
  pushedAt: string | null;
  /** Newest trunk commit already turned into a push event. */
  lastCommitSha: string | null;
  lastPolledAt: string | null;
  defaultBranch: string | null;
  /** Consecutive failures, driving exponential backoff. */
  failures: number;
  /** Backoff gate: the poller skips this repo until then. */
  nextEligibleAt: string | null;
  lastError: string | null;
}

/** What the last cycle did, surfaced so the UI can say why it is quiet. */
export interface CycleStatus {
  /** Monotonic counter, persisted so the rolling sweep resumes across restarts
   *  rather than replaying the same slice of the roster forever. */
  cycle: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Repos actually polled this cycle. */
  polled: string[];
  /** Watched repos skipped because nothing had changed. */
  skipped: number;
  /** Eligible repos left for the next cycle because of the per-cycle cap. */
  deferred: number;
  newEvents: number;
  errors: Array<{ slug: string; message: string }>;
  /** Set when the rate-limit budget forced the cycle to do less. */
  throttled: boolean;
  rateRemaining: number | null;
}

/** The bounded snapshot the page reads; never the whole history. */
export interface FeedIndex {
  events: FeedEvent[];
  /**
   * The last full observation across the watchlist — every state, not only
   * open. This is what the next cycle diffs against, and it has to include
   * merged and closed PRs: a repo whose open PRs all land would otherwise
   * disappear from the previous observation and be treated as never seen
   * again, silently suppressing its events from then on.
   */
  prs: PrSnapshot[];
  updatedAt: string;
}

/** Everything GET /api/feed returns. */
export interface FeedView extends FeedIndex {
  watchlist: WatchEntry[];
  status: CycleStatus | null;
  /** Null when no watcher process holds the lock. */
  watcher: { pid: number; startedAt: string; heartbeatAt: string } | null;
}
