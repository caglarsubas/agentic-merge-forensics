/**
 * Choosing which repos to poll this cycle.
 *
 * One `/user/repos?sort=pushed` call prices the entire watchlist at effectively
 * nothing, while every repo actually polled costs two `gh` invocations at 3-8
 * seconds each. The cost of a cycle is therefore the size of the hot set, and
 * the whole job here is to keep that set small without letting the feed pretend
 * the rest were checked.
 *
 * `pushed_at` is the cheap signal and it is not sufficient. It does not move
 * when a PR is opened from a fork, when a review lands, when a check finishes,
 * or when GitHub finally computes a mergeability it had been reporting as
 * UNKNOWN. A planner that trusted it alone would go permanently blind to those
 * events, not merely late. The rolling sweep is the answer: a deterministic
 * slice of the roster is polled every cycle whatever the listing says, so the
 * failure mode degrades from "never" to "slow", and `sweepCycles` says how slow.
 *
 * Pure and clock-free — `now` is an argument. That is not decoration: the only
 * practical way to assert the sweep's coverage property is to run a hundred
 * cycles in a millisecond, which needs a clock the test owns.
 */
import type { PrSnapshot, RepoWatermark, WatchEntry } from "./types";

/** Two `gh` calls per repo at 3-8s each; twelve is about a two-minute cycle. */
export const DEFAULT_CAP = 12;
/** Below this, a second poll would mostly re-read what the first one just read. */
export const DEFAULT_MIN_REPOLL_MS = 60_000;
/** A quarter of the roster per cycle: full coverage every four cycles. */
export const DEFAULT_SWEEP_SLICE = 0.25;
export const DEFAULT_BACKOFF_BASE_MS = 60_000;
/**
 * Backoff ceiling. Half an hour, because the failures this actually sees are
 * expired auth, a repo that was renamed, and rate limiting — the first two get
 * fixed by a human on a human timescale, and an unbounded backoff would leave
 * the repo dark long after the fix. Slow retries are cheap; a feed that stays
 * silently blind is not.
 */
export const BACKOFF_CEILING_MS = 30 * 60_000;

/** Why a repo made the cut. Reported so the UI can explain a busy cycle. */
export type PollReason =
  /** Never successfully polled, so nothing is known about it yet. */
  | "cold"
  /** `pushed_at` moved past the watermark. */
  | "pushed"
  /** Last look left something in flight: CI pending, or mergeability UNKNOWN. */
  | "unsettled"
  /** Failed before and the backoff window has expired. */
  | "retry"
  /** This cycle's slice of the rolling sweep. */
  | "sweep";

/** Why a repo did not. "quiet" is the ordinary case; the rest are gates. */
export type SkipReason = "paused" | "backoff" | "cooldown" | "quiet";

/** One repo the cycle intends to poll, with why and how overdue it was. */
export interface PlannedPoll {
  slug: string;
  reason: PollReason;
  /** ms since the last successful poll; Infinity when it has never had one. */
  staleMs: number;
}

export interface SkippedRepo {
  slug: string;
  reason: SkipReason;
  /** For "backoff", when the repo becomes eligible again. */
  until?: string;
}

export interface PlanInput {
  /** The user's list, in whatever order they added things. */
  watchlist: readonly WatchEntry[];
  /** Persisted poller state by slug. A missing entry means never polled. */
  watermarks: Readonly<Record<string, RepoWatermark>>;
  /**
   * `pushed_at` per slug from the one cheap repo listing. A slug missing here
   * is not evidence of quiet: `/user/repos` only covers repos the token is
   * affiliated with, and a watched public repo can simply be absent. Those
   * repos are reached by the sweep and by nothing else.
   */
  pushedAt: Readonly<Record<string, string | null>>;
  /** Open PRs as the feed last saw them — the source of the unsettled signal. */
  openPrs?: readonly PrSnapshot[];
  /**
   * Cycle counter, incremented by the poller. The sweep slice is derived from
   * it rather than from randomness so coverage is a promise rather than a
   * probability. Persisting it across restarts only saves a repeated slice.
   */
  cycle: number;
  cap?: number;
  minRepollMs?: number;
  /** Fraction of the roster swept per cycle, clamped to [0, 1]. */
  sweepSlice?: number;
}

export interface CyclePlan {
  /** The counter this plan was derived from, normalised to an integer. */
  cycle: number;
  /** Repos to poll, most overdue first, already truncated to the cap. */
  poll: PlannedPoll[];
  /**
   * Eligible repos the cap pushed out. Surfaced rather than dropped silently,
   * because "12 of 30 repos checked" is a different claim from "all quiet".
   */
  deferred: string[];
  /** Everything gated out, with the gate that did it. */
  skipped: SkippedRepo[];
  /** This cycle's sweep slice, before eligibility gates ran on it. */
  sweep: string[];
  /**
   * Cycles for the sweep to cover the roster once. The guarantee holds while
   * the cap is not being eaten by repos that genuinely changed; when it is,
   * coverage stretches and the deferred count is what shows it.
   */
  sweepCycles: number;
}

/**
 * How long to wait before retrying a repo that has failed `failures` times in
 * a row. Doubling from `baseMs`, ceilinged at BACKOFF_CEILING_MS.
 */
export function backoffFor(failures: number, baseMs: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : DEFAULT_BACKOFF_BASE_MS;
  // Clamped before the shift: 2 ** 1024 is Infinity, and Math.min(Infinity, x)
  // would still give the right answer while making the intermediate nonsense.
  const doublings = Math.min(Math.floor(failures) - 1, 32);
  return Math.min(base * 2 ** doublings, BACKOFF_CEILING_MS);
}

/** Byte order, not locale order: every process must derive the same roster. */
function compareSlug(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Did GitHub's push timestamp move past what the last poll recorded?
 *
 * An absent `fresh` means the listing did not mention the repo, which says
 * nothing either way, so it is not treated as movement.
 */
function pushedAdvanced(fresh: string | null | undefined, known: string | null): boolean {
  if (fresh == null) return false;
  if (known == null) return true;
  const a = parseMs(fresh);
  const b = parseMs(known);
  // Unparseable on either side: any difference at all is treated as movement,
  // since the alternative is to ignore a signal we cannot read.
  if (a === null || b === null) return fresh !== known;
  return a > b;
}

/**
 * Repos with something in flight that will resolve without a push behind it —
 * a check that is still running, or a mergeability GitHub has not computed yet.
 * Both change under `pushed_at` without moving it.
 */
function unsettledRepos(openPrs: readonly PrSnapshot[]): Set<string> {
  const repos = new Set<string>();
  for (const pr of openPrs) {
    if (pr.state !== "open") continue;
    if (pr.ci === "pending" || pr.conflict === "unknown") repos.add(pr.repo);
  }
  return repos;
}

interface SweepWindow {
  slice: string[];
  cycles: number;
}

function sweepWindow(
  roster: readonly string[],
  fraction: number,
  cap: number,
  cycle: number,
): SweepWindow {
  if (roster.length === 0 || fraction <= 0) return { slice: [], cycles: 0 };
  const wanted = Math.ceil(roster.length * Math.min(fraction, 1));
  // A slice wider than the cycle cap is a promise the cap cannot keep, so it is
  // narrowed here rather than announced and then quietly truncated below.
  const size = Math.max(1, cap > 0 ? Math.min(wanted, cap) : wanted);
  const cycles = Math.ceil(roster.length / size);
  const index = ((cycle % cycles) + cycles) % cycles;
  const start = index * size;
  // Deliberately not wrapping past the end: a short final slice covers the
  // roster exactly once per rotation, where a wrapping window would re-poll
  // the head and let the tail drift out of the promised window.
  return { slice: roster.slice(start, start + size), cycles };
}

function reasonFor(
  slug: string,
  mark: RepoWatermark | undefined,
  neverPolled: boolean,
  input: PlanInput,
  unsettled: ReadonlySet<string>,
  sweep: ReadonlySet<string>,
): PollReason | null {
  // `neverPolled` rather than a null check, so a hand-edited state file with an
  // unreadable timestamp degrades to one extra poll instead of to a repo that
  // is quietly never eligible again.
  if (!mark || neverPolled) return "cold";
  if (pushedAdvanced(input.pushedAt[slug], mark.pushedAt)) return "pushed";
  if (unsettled.has(slug)) return "unsettled";
  // The backoff gate ran before this, so a repo with failures on record here is
  // one whose window has expired. It needs a poll of its own: the sweep would
  // eventually reach it, but a repo that errored mid-push has no other route
  // back — its watermark never advanced, so nothing else marks it interesting.
  if (mark.failures > 0) return "retry";
  if (sweep.has(slug)) return "sweep";
  return null;
}

/** Sweep candidates sort behind everything else; see the note in planCycle. */
function tierOf(reason: PollReason): number {
  return reason === "sweep" ? 1 : 0;
}

export function planCycle(input: PlanInput, now: Date): CyclePlan {
  const cap = Math.max(0, Math.floor(input.cap ?? DEFAULT_CAP));
  const minRepollMs = Math.max(0, input.minRepollMs ?? DEFAULT_MIN_REPOLL_MS);
  const fraction = Math.min(Math.max(input.sweepSlice ?? DEFAULT_SWEEP_SLICE, 0), 1);
  const cycle = Number.isFinite(input.cycle) ? Math.trunc(input.cycle) : 0;
  const nowMs = now.getTime();

  // A slug listed twice is a mistake in the user's list, not a reason to spend
  // four `gh` calls on it.
  const seen = new Set<string>();
  const entries: WatchEntry[] = [];
  for (const entry of input.watchlist) {
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    entries.push(entry);
  }

  // The sweep roster is sorted and excludes paused repos, so the rotation is
  // stable no matter what order the user's list is in and never spends a slot
  // on a repo it is forbidden to poll.
  const roster = entries
    .filter((entry) => !entry.paused)
    .map((entry) => entry.slug)
    .sort(compareSlug);
  const { slice, cycles } = sweepWindow(roster, fraction, cap, cycle);
  const sweep = new Set(slice);
  const unsettled = unsettledRepos(input.openPrs ?? []);

  const candidates: PlannedPoll[] = [];
  const skipped: SkippedRepo[] = [];

  for (const entry of entries) {
    const slug = entry.slug;
    if (entry.paused) {
      skipped.push({ slug, reason: "paused" });
      continue;
    }

    const mark = input.watermarks[slug];
    const eligibleAt = parseMs(mark?.nextEligibleAt);
    if (eligibleAt !== null && nowMs < eligibleAt) {
      // Backoff outranks a fresh push on purpose: a repo that is erroring is
      // erroring, and new commits do not make the API answer.
      skipped.push({ slug, reason: "backoff", until: mark.nextEligibleAt ?? undefined });
      continue;
    }

    const lastPolled = parseMs(mark?.lastPolledAt);
    const staleMs = lastPolled === null ? Number.POSITIVE_INFINITY : nowMs - lastPolled;
    if (staleMs < minRepollMs) {
      // Two pushes a few seconds apart are one story. The second poll would
      // cost the same two `gh` calls to report the same PR.
      skipped.push({ slug, reason: "cooldown" });
      continue;
    }

    const reason = reasonFor(slug, mark, lastPolled === null, input, unsettled, sweep);
    if (!reason) {
      skipped.push({ slug, reason: "quiet" });
      continue;
    }
    candidates.push({ slug, reason, staleMs });
  }

  // Longest unpolled first, which also means a repo the cap deferred last cycle
  // outranks the ones that beat it. The tier ahead of staleness is the one
  // deliberate exception: at 161 repos the sweep alone fills the cap, and a
  // pure staleness sort would then park every real push behind a full rotation.
  // A feed that reports a merge twenty minutes late is not a live feed, so the
  // sweep yields to anything that actually changed and pays for it in deferred.
  candidates.sort((a, b) => {
    const tier = tierOf(a.reason) - tierOf(b.reason);
    if (tier !== 0) return tier;
    // Both Infinity compares equal here rather than producing NaN.
    if (a.staleMs !== b.staleMs) return b.staleMs - a.staleMs;
    return compareSlug(a.slug, b.slug);
  });

  const poll = cap > 0 ? candidates.slice(0, cap) : [];
  const deferred = (cap > 0 ? candidates.slice(cap) : candidates).map((entry) => entry.slug);

  return { cycle, poll, deferred, skipped, sweep: slice, sweepCycles: cycles };
}
