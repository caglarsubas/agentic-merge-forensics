/**
 * Turning per-PR analysis into the report's numbers.
 *
 * Pure functions over plain data: no git, no network, so the statistics can be
 * tested directly and the definitions stay legible. Every rate here has an
 * explicit denominator, because "2% conflict rate" is meaningless without
 * knowing whether it is per-PR or per-merge-attempt.
 */
import type {
  ConcurrentPair,
  CoderStats,
  Distribution,
  FileContention,
  ForensicsReport,
  Interaction,
  MergeKind,
  PrAnalysis,
} from "./types";

export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  if (lower === position) return sorted[lower];
  return sorted[lower] + (sorted[lower + 1] - sorted[lower]) * (position - lower);
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return { median: 0, p90: 0, max: 0, mean: 0, total: 0 };
  }
  const total = values.reduce((sum, v) => sum + v, 0);
  return {
    median: round(quantile(values, 0.5)),
    p90: round(quantile(values, 0.9)),
    max: Math.max(...values),
    mean: round(total / values.length),
    total,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Bucket a rewritten line by how old the code it replaced was. */
export function ageBucket(ageDays: number): string {
  if (ageDays <= 1) return "<=1d";
  if (ageDays <= 3) return "1-3d";
  if (ageDays <= 7) return "3-7d";
  if (ageDays <= 14) return "7-14d";
  return ">14d";
}

export function rewriteAgeBuckets(interactions: readonly Interaction[]): Record<string, number> {
  const buckets: Record<string, number> = {
    "<=1d": 0,
    "1-3d": 0,
    "3-7d": 0,
    "7-14d": 0,
    ">14d": 0,
  };
  for (const interaction of interactions) {
    buckets[ageBucket(interaction.ageDays)] += interaction.lines;
  }
  return buckets;
}

/**
 * Overwrite split. The distinction that matters is whether an agent rewrote
 * *its own* recent work (normal iteration) or another agent's (a coordination
 * failure) — the aggregate number conflates two very different things.
 */
/** Rewrites of code younger than this are the ones that indicate a race. */
export const FRESH_CODE_DAYS = 3;

export function overwriteSplit(
  interactions: readonly Interaction[],
  maxAgeDays?: number,
): {
  crossCoder: number;
  sameCoder: number;
  unattributed: number;
  matrix: Record<string, number>;
} {
  let crossCoder = 0;
  let sameCoder = 0;
  let unattributed = 0;
  const matrix: Record<string, number> = {};
  for (const interaction of interactions) {
    if (maxAgeDays !== undefined && interaction.ageDays > maxAgeDays) continue;
    // An unidentified side is *not* evidence of crossing agents. Counting it
    // as cross-coder is how this metric gets silently inflated, since lines
    // authored before the window have no coder unless one was resolved.
    if (interaction.sourceCoder === "unknown" || interaction.targetCoder === "unknown") {
      unattributed += interaction.lines;
      continue;
    }
    const key = `${interaction.sourceCoder} -> ${interaction.targetCoder}`;
    matrix[key] = (matrix[key] ?? 0) + interaction.lines;
    if (interaction.sourceCoder === interaction.targetCoder) {
      sameCoder += interaction.lines;
    } else {
      crossCoder += interaction.lines;
    }
  }
  return { crossCoder, sameCoder, unattributed, matrix };
}

/** PRs open at the same moment, and which of those shared a file. */
export function concurrentPairs(
  prs: readonly PrAnalysis[],
  conflictedPrs: ReadonlySet<number>,
): { pairs: ConcurrentPair[]; openOverlapPairs: number; peakOpen: number } {
  const intervals = prs
    .filter((pr) => pr.createdAt)
    .map((pr) => ({
      number: pr.number,
      start: new Date(pr.createdAt as string).getTime(),
      end: new Date(pr.mergedAt).getTime(),
      files: new Set(pr.files),
    }));

  const pairs: ConcurrentPair[] = [];
  let openOverlapPairs = 0;
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i];
      const b = intervals[j];
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      if (start >= end) continue;
      openOverlapPairs++;
      const shared = [...a.files].filter((file) => b.files.has(file)).sort();
      if (shared.length > 0) {
        pairs.push({
          a: a.number,
          b: b.number,
          overlapHours: round((end - start) / 3_600_000),
          sharedFiles: shared,
          conflicted: conflictedPrs.has(a.number) || conflictedPrs.has(b.number),
        });
      }
    }
  }

  const events: Array<[number, number]> = [];
  for (const interval of intervals) {
    events.push([interval.start, 1], [interval.end, -1]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let open = 0;
  let peakOpen = 0;
  for (const [, delta] of events) {
    open += delta;
    peakOpen = Math.max(peakOpen, open);
  }

  return {
    pairs: pairs.sort((x, y) => y.sharedFiles.length - x.sharedFiles.length),
    openOverlapPairs,
    peakOpen,
  };
}

export function hotFiles(
  prs: readonly PrAnalysis[],
  interactions: readonly Interaction[],
  limit = 20,
): FileContention[] {
  const byFile = new Map<string, Set<number>>();
  for (const pr of prs) {
    for (const file of pr.files) {
      let set = byFile.get(file);
      if (!set) byFile.set(file, (set = new Set()));
      set.add(pr.number);
    }
  }
  const crossPrLines = new Map<string, number>();
  for (const interaction of interactions) {
    crossPrLines.set(
      interaction.file,
      (crossPrLines.get(interaction.file) ?? 0) + interaction.lines,
    );
  }
  return [...byFile.entries()]
    .map(([file, prSet]) => ({
      file,
      prCount: prSet.size,
      prs: [...prSet].sort((a, b) => a - b),
      crossPrLines: crossPrLines.get(file) ?? 0,
    }))
    .sort((a, b) => b.prCount - a.prCount || b.crossPrLines - a.crossPrLines)
    .slice(0, limit);
}

export function coderStats(prs: readonly PrAnalysis[]): CoderStats[] {
  const byCoder = new Map<string, PrAnalysis[]>();
  for (const pr of prs) {
    const list = byCoder.get(pr.coder) ?? [];
    list.push(pr);
    byCoder.set(pr.coder, list);
  }
  return [...byCoder.entries()]
    .map(([coder, list]) => {
      const ttms = list
        .map((pr) => pr.timeToMergeHours)
        .filter((v): v is number => v !== null);
      return {
        coder,
        prs: list.length,
        additions: list.reduce((sum, pr) => sum + pr.additions, 0),
        deletions: list.reduce((sum, pr) => sum + pr.deletions, 0),
        medianTimeToMergeHours: ttms.length ? round(quantile(ttms, 0.5)) : null,
        conflicts: list.filter((pr) => pr.conflicts.length > 0).length,
        branchUpdates: list.reduce((sum, pr) => sum + pr.branchUpdates, 0),
        forcePushes: list.reduce((sum, pr) => sum + pr.forcePushes, 0),
        fixPrs: list.filter((pr) => /^fix/i.test(pr.title)).length,
      };
    })
    .sort((a, b) => b.prs - a.prs);
}

export function titleTypes(prs: readonly PrAnalysis[]): Record<string, number> {
  const types: Record<string, number> = {};
  for (const pr of prs) {
    const match = /^(\w+)[(:]/.exec(pr.title);
    const key = match ? match[1].toLowerCase() : "other";
    types[key] = (types[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(types).sort((a, b) => b[1] - a[1]));
}

export interface BuildMetricsInput {
  prs: PrAnalysis[];
  interactions: Interaction[];
  repos: string[];
  window: ForensicsReport["window"];
  coderFilter: string[] | null;
  warnings: string[];
  generatedAt: string;
}

export function buildReport(input: BuildMetricsInput): ForensicsReport {
  const { prs, interactions } = input;
  const conflictedPrs = prs.filter((pr) => pr.conflicts.length > 0).map((pr) => pr.number);
  const conflictedSet = new Set(conflictedPrs);
  const { pairs, peakOpen } = concurrentPairs(prs, conflictedSet);
  const { crossCoder, sameCoder, unattributed, matrix } = overwriteSplit(interactions);
  // The headline number. Rewriting month-old code across agents is ordinary
  // maintenance; rewriting code another agent landed days ago is a race.
  const fresh = overwriteSplit(interactions, FRESH_CODE_DAYS);

  const totalAdded = prs.reduce((sum, pr) => sum + pr.additions, 0);
  const inWindow = new Set(prs.map((pr) => pr.number));
  const churnedLines = interactions
    .filter((interaction) => inWindow.has(interaction.sourcePr))
    .reduce((sum, interaction) => sum + interaction.lines, 0);

  const spanDays = input.window.spanDays;
  const mergeKinds: Record<MergeKind, number> = { merge: 0, squash: 0 };
  for (const pr of prs) mergeKinds[pr.kind]++;

  return {
    generatedAt: input.generatedAt,
    repos: input.repos,
    window: input.window,
    coderFilter: input.coderFilter,
    prCount: prs.length,
    prs,
    interactions,
    warnings: input.warnings,
    metrics: {
      mergesPerDay: spanDays > 0 ? round(prs.length / spanDays) : prs.length,
      peakConcurrentOpen: peakOpen,
      additions: distribution(prs.map((pr) => pr.additions)),
      deletions: distribution(prs.map((pr) => pr.deletions)),
      changedFiles: distribution(prs.map((pr) => pr.changedFiles)),
      timeToMergeHours: distribution(
        prs.map((pr) => pr.timeToMergeHours).filter((v): v is number => v !== null),
      ),
      commits: distribution(prs.map((pr) => pr.commits)),
      conflictRatePct: prs.length ? round((100 * conflictedPrs.length) / prs.length) : 0,
      conflictedPrs,
      prsWithBranchUpdate: prs.filter((pr) => pr.branchUpdates > 0).length,
      prsWithForcePush: prs.filter((pr) => pr.forcePushes > 0).length,
      crossCoderOverwriteLines: crossCoder,
      sameCoderOverwriteLines: sameCoder,
      unattributedOverwriteLines: unattributed,
      overwriteMatrix: matrix,
      crossCoderFreshOverwriteLines: fresh.crossCoder,
      sameCoderFreshOverwriteLines: fresh.sameCoder,
      freshOverwriteMatrix: fresh.matrix,
      churnRatePct: totalAdded ? round((100 * churnedLines) / totalAdded) : 0,
      churnedLines,
      totalAdded,
      rewriteAgeBuckets: rewriteAgeBuckets(interactions),
      concurrentPairs: pairs,
      concurrentPairsSharingFiles: pairs.length,
      hotFiles: hotFiles(prs, interactions),
      coders: coderStats(prs),
      reverts: prs.filter((pr) => /\brevert\b/i.test(pr.title)).map((pr) => pr.number),
      fixPrs: prs.filter((pr) => /^fix/i.test(pr.title)).map((pr) => pr.number),
      mergedWithFailingChecks: prs
        .filter((pr) => pr.failingChecksAtMerge > 0)
        .map((pr) => pr.number),
      prsWithReview: prs.filter((pr) => pr.reviews > 0).length,
      titleTypes: titleTypes(prs),
      mergeKinds,
    },
  };
}
