/** Shared shapes for the forensics engine. */

/** `owner/name` as GitHub knows it. */
export interface RepoRef {
  owner: string;
  name: string;
}

export function repoSlug(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function parseRepoRef(input: string): RepoRef {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`invalid_repo_ref:${input}`);
  }
  return { owner: parts[0], name: parts[1] };
}

/** How a PR arrived on the trunk. */
export type MergeKind = "merge" | "squash";

/** A merge of a pull request onto the trunk, as found in git history. */
export interface MergedPr {
  number: number;
  sha: string;
  parents: string[];
  /** Commit date of the merge, ISO-8601. */
  mergedAt: string;
  kind: MergeKind;
  subject: string;
}

/** Everything GitHub knows about the PR. Absent when running without `gh`. */
export interface PrMetadata {
  number: number;
  title: string;
  authorLogin: string;
  headRefName: string;
  createdAt: string;
  mergedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  /** Branch-update merges the branch took from the trunk while open. */
  branchUpdates: number;
  forcePushes: number;
  reviews: number;
  comments: number;
  failingChecksAtMerge: number;
}

/** A textual conflict recovered by replaying a merge. */
export interface ConflictEvent {
  where: "branch-update" | "final-merge";
  commit: string;
  headline: string;
  files: string[];
}

/** One PR's worth of analysis. */
export interface PrAnalysis {
  number: number;
  sha: string;
  kind: MergeKind;
  title: string;
  coder: string;
  authorLogin: string;
  headRefName: string;
  createdAt: string | null;
  mergedAt: string;
  timeToMergeHours: number | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: string[];
  commits: number;
  branchUpdates: number;
  forcePushes: number;
  reviews: number;
  comments: number;
  failingChecksAtMerge: number;
  conflicts: ConflictEvent[];
  /** Pre-existing lines this PR rewrote, total. */
  rewrittenLines: number;
  /** Of those, lines whose authoring PR merged within 3 days. */
  rewrittenFreshLines: number;
  /** Lines this PR authored that a later in-window PR rewrote. */
  reworkedLines: number;
}

/** A rewrite of one PR's lines by another. */
export interface Interaction {
  sourcePr: number;
  targetPr: number;
  file: string;
  lines: number;
  ageDays: number;
  sourceCoder: string;
  targetCoder: string;
}

/** Two PRs open at the same time that touched the same file. */
export interface ConcurrentPair {
  a: number;
  b: number;
  overlapHours: number;
  sharedFiles: string[];
  conflicted: boolean;
}

export interface FileContention {
  file: string;
  prCount: number;
  prs: number[];
  crossPrLines: number;
}

export interface CoderStats {
  coder: string;
  prs: number;
  additions: number;
  deletions: number;
  medianTimeToMergeHours: number | null;
  conflicts: number;
  branchUpdates: number;
  forcePushes: number;
  fixPrs: number;
}

export interface Distribution {
  median: number;
  p90: number;
  max: number;
  mean: number;
  total: number;
}

/** The complete result of one analysis run. */
export interface ForensicsReport {
  generatedAt: string;
  repos: string[];
  window: {
    /** How the PR set was chosen. */
    mode: "count" | "since";
    requested: number | string;
    firstMergedAt: string | null;
    lastMergedAt: string | null;
    spanDays: number;
  };
  coderFilter: string[] | null;
  prCount: number;
  prs: PrAnalysis[];
  interactions: Interaction[];
  metrics: {
    mergesPerDay: number;
    peakConcurrentOpen: number;
    additions: Distribution;
    deletions: Distribution;
    changedFiles: Distribution;
    timeToMergeHours: Distribution;
    commits: Distribution;
    /** PRs with a replayed textual conflict / total. */
    conflictRatePct: number;
    conflictedPrs: number[];
    prsWithBranchUpdate: number;
    prsWithForcePush: number;
    /** Lines rewritten that were authored by a *different* coder. */
    crossCoderOverwriteLines: number;
    sameCoderOverwriteLines: number;
    /** Rewritten lines where a coder could not be identified on one side. */
    unattributedOverwriteLines: number;
    /** `"claude -> codex"` -> lines, for the overwrite matrix. */
    overwriteMatrix: Record<string, number>;
    /**
     * The same split restricted to code less than 3 days old. Rewriting
     * month-old code across agents is maintenance; rewriting days-old code is
     * a race, so the two must not share one number.
     */
    crossCoderFreshOverwriteLines: number;
    sameCoderFreshOverwriteLines: number;
    freshOverwriteMatrix: Record<string, number>;
    /** Lines added in-window that a later in-window PR rewrote. */
    churnRatePct: number;
    churnedLines: number;
    totalAdded: number;
    rewriteAgeBuckets: Record<string, number>;
    concurrentPairs: ConcurrentPair[];
    concurrentPairsSharingFiles: number;
    hotFiles: FileContention[];
    coders: CoderStats[];
    reverts: number[];
    fixPrs: number[];
    mergedWithFailingChecks: number[];
    prsWithReview: number;
    titleTypes: Record<string, number>;
    /** Merge method split, which affects blame/bisect consistency. */
    mergeKinds: Record<MergeKind, number>;
  };
  /** Non-fatal problems worth surfacing rather than hiding. */
  warnings: string[];
}
