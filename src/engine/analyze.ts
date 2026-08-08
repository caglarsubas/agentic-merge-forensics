/**
 * The analysis run.
 *
 * Order matters here:
 *   1. mirror + fetch, so every later step is local
 *   2. discover PR merges on the trunk (first-parent only)
 *   3. build a commit -> PR map across a *wider* context window than the
 *      selection, so blame can attribute lines to PRs older than the window
 *   4. per PR: diff stats, blame attribution, conflict replay
 *   5. aggregate
 *
 * Step 3 is the one that is easy to get wrong: attributing against only the
 * selected PRs makes older code look unowned and silently understates the
 * overwrite rate.
 */
import { mapLimit } from "./exec";
import { ensureMirror, defaultBranch } from "./repo-cache";
import {
  blameLineCommits,
  commitMessage,
  commitsBetween,
  firstParentLog,
  gitVersion,
  mergeBase,
  numstat,
  parentsOf,
  replayMerge,
  revExists,
  unifiedZeroDiff,
  type GitContext,
} from "./git-queries";
import {
  diffBaseOf,
  findDirectPushes,
  findPrMerges,
  headRefFromMergeSubject,
  selectWindow,
} from "./discover";
import { isUninterestingPath, oldSideLineNumbers } from "./diff";
import { detectCoder, type CoderRule } from "./coder";
import { buildReport } from "./metrics";
import { fetchPrs, ghAvailable, ghAuthenticated } from "./github";
import type {
  ConflictEvent,
  ForensicsReport,
  Interaction,
  MergedPr,
  PrAnalysis,
  PrMetadata,
  RepoRef,
} from "./types";
import { repoSlug } from "./types";

export interface AnalyzeOptions {
  repos: RepoRef[];
  /** Analyse the most recent N PR merges. Mutually exclusive with `since`. */
  count?: number;
  /** Analyse everything merged at or after this date. */
  since?: Date;
  /** Keep only these coders. Null means all. */
  coders?: string[] | null;
  coderRules?: CoderRule[];
  /** Skip `gh` entirely; git-only metrics. */
  offline?: boolean;
  concurrency?: number;
  onProgress?: (message: string) => void;
}

const HISTORY_SCAN_LIMIT = 2000;

export async function analyze(options: AnalyzeOptions): Promise<ForensicsReport> {
  const progress = options.onProgress ?? (() => {});
  const warnings: string[] = [];
  const concurrency = options.concurrency ?? 6;

  const [major, minor] = await gitVersion();
  if (major < 2 || (major === 2 && minor < 38)) {
    warnings.push(
      `git ${major}.${minor} predates \`merge-tree --write-tree\` (2.38); conflict replay is unavailable and the conflict rate will read 0.`,
    );
  }

  let useGh = !options.offline;
  if (useGh && !(await ghAvailable())) {
    useGh = false;
    warnings.push("`gh` not found — PR titles, authors and review data are unavailable.");
  } else if (useGh && !(await ghAuthenticated())) {
    useGh = false;
    warnings.push("`gh` is not authenticated — falling back to git-only metrics.");
  }

  const allPrs: PrAnalysis[] = [];
  const allInteractions: Interaction[] = [];
  const repoSlugs: string[] = [];

  for (const repo of options.repos) {
    repoSlugs.push(repoSlug(repo));
    const result = await analyzeRepo(repo, options, useGh, concurrency, progress, warnings);
    allPrs.push(...result.prs);
    allInteractions.push(...result.interactions);
  }

  // Coder filtering happens after analysis so that a filtered report still
  // reports overwrites *by* excluded coders against the ones kept — dropping
  // them earlier would hide exactly the cross-agent interference being sought.
  const filtered = options.coders?.length
    ? allPrs.filter((pr) => options.coders?.includes(pr.coder))
    : allPrs;
  if (options.coders?.length && filtered.length === 0) {
    warnings.push(
      `No PRs matched the coder filter (${options.coders.join(", ")}). Detected coders: ${[
        ...new Set(allPrs.map((pr) => pr.coder)),
      ].join(", ") || "none"}.`,
    );
  }

  const keptNumbers = new Set(filtered.map((pr) => pr.number));
  const keptInteractions = allInteractions.filter(
    (i) => keptNumbers.has(i.targetPr) || keptNumbers.has(i.sourcePr),
  );

  const sorted = [...filtered].sort(
    (a, b) => new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime(),
  );
  const first = sorted[0]?.mergedAt ?? null;
  const last = sorted[sorted.length - 1]?.mergedAt ?? null;
  const spanDays =
    first && last
      ? Math.max(
          (new Date(last).getTime() - new Date(first).getTime()) / 86_400_000,
          1 / 24,
        )
      : 0;

  return buildReport({
    prs: sorted.reverse(),
    interactions: keptInteractions,
    repos: repoSlugs,
    coderFilter: options.coders?.length ? options.coders : null,
    warnings,
    generatedAt: new Date().toISOString(),
    window: {
      mode: options.since ? "since" : "count",
      requested: options.since ? options.since.toISOString() : (options.count ?? 50),
      firstMergedAt: first,
      lastMergedAt: last,
      spanDays: Math.round(spanDays * 10) / 10,
    },
  });
}

interface RepoResult {
  prs: PrAnalysis[];
  interactions: Interaction[];
}

async function analyzeRepo(
  repo: RepoRef,
  options: AnalyzeOptions,
  useGh: boolean,
  concurrency: number,
  progress: (message: string) => void,
  warnings: string[],
): Promise<RepoResult> {
  const slug = repoSlug(repo);
  const gitDir = await ensureMirror(repo, progress);
  const ctx: GitContext = { gitDir };
  const trunk = await defaultBranch(gitDir);

  progress(`${slug}: reading trunk history`);
  const commits = await firstParentLog(ctx, trunk, HISTORY_SCAN_LIMIT);
  const merges = findPrMerges(commits);
  if (merges.length === 0) {
    warnings.push(`${slug}: no PR merges found in the last ${HISTORY_SCAN_LIMIT} trunk commits.`);
    return { prs: [], interactions: [] };
  }

  const directPushes = findDirectPushes(commits);
  if (directPushes.length > 0) {
    warnings.push(
      `${slug}: ${directPushes.length} trunk commit(s) in the scanned history are direct pushes, not PR merges.`,
    );
  }

  const { selected, context } = selectWindow(merges, {
    count: options.count,
    since: options.since,
  });
  if (selected.length === 0) {
    warnings.push(`${slug}: no PR merges fell inside the requested window.`);
    return { prs: [], interactions: [] };
  }
  progress(`${slug}: ${selected.length} PR merges selected (${context.length} in attribution context)`);

  const shaToPr = await buildShaToPrMap(ctx, context, concurrency);
  const mergedAtByPr = new Map(context.map((m) => [m.number, new Date(m.mergedAt)]));
  // Coders for the whole attribution context, from git alone. Without this,
  // every line authored before the window has no coder and each rewrite of it
  // reads as a cross-agent overwrite.
  const contextCoders = await resolveContextCoders(
    ctx,
    context,
    concurrency,
    options.coderRules,
  );

  let metadata = new Map<number, { metadata: PrMetadata | null; commitMessages: string[] }>();
  if (useGh) {
    progress(`${slug}: fetching PR metadata for ${selected.length} PRs`);
    metadata = await fetchPrs(
      repo,
      selected.map((m) => m.number),
      concurrency,
      (done, total) => {
        if (done % 10 === 0 || done === total) progress(`${slug}: metadata ${done}/${total}`);
      },
    );
  }

  progress(`${slug}: analysing diffs, blame and merges`);
  const interactions: Interaction[] = [];
  const uninspected: number[] = [];
  const analyses = await mapLimit(selected, Math.min(concurrency, 4), async (merge, index) => {
    if (index % 10 === 0) progress(`${slug}: PR analysis ${index}/${selected.length}`);
    return analyzePr({
      ctx,
      repo,
      merge,
      meta: metadata.get(merge.number),
      shaToPr,
      mergedAtByPr,
      coderRules: options.coderRules,
      interactions,
      uninspected,
    });
  });

  // Never let an unexaminable PR read as "clean" — that would understate the
  // conflict rate in exactly the repos where branches are pruned aggressively.
  if (uninspected.length > 0) {
    warnings.push(
      `${slug}: ${uninspected.length} squash-merged PR(s) had no reachable branch (head ref gone), so conflicts could not be replayed for them: ${uninspected
        .slice(0, 10)
        .join(", ")}${uninspected.length > 10 ? ", …" : ""}. The conflict rate is a floor.`,
    );
  }

  // Fill in interaction coders. Analysed PRs win — they had GitHub metadata,
  // which is richer than what git alone can recover — and the context map
  // covers everything older than the window.
  const coderByPr = new Map(contextCoders);
  for (const pr of analyses) coderByPr.set(pr.number, pr.coder);

  // A squash-merged PR keeps no branch name anywhere in git, so context PRs
  // that were squashed stay unknown. Rather than fetch metadata for the whole
  // context, backfill only the ones that actually authored rewritten lines —
  // usually a handful, and the difference between a real cross-agent overwrite
  // and an unattributed one.
  if (useGh) {
    const needsBackfill = [
      ...new Set(
        interactions
          .map((i) => i.sourcePr)
          .filter((number) => (coderByPr.get(number) ?? "unknown") === "unknown"),
      ),
    ];
    if (needsBackfill.length > 0) {
      progress(`${slug}: resolving ${needsBackfill.length} out-of-window overwrite source(s)`);
      const backfilled = await fetchPrs(repo, needsBackfill, concurrency);
      for (const [number, result] of backfilled) {
        if (!result.metadata) continue;
        coderByPr.set(
          number,
          detectCoder(
            {
              headRefName: result.metadata.headRefName,
              commitMessages: result.commitMessages,
              authorLogin: result.metadata.authorLogin,
            },
            options.coderRules,
          ),
        );
      }
    }
  }

  for (const interaction of interactions) {
    interaction.sourceCoder = coderByPr.get(interaction.sourcePr) ?? "unknown";
    interaction.targetCoder = coderByPr.get(interaction.targetPr) ?? "unknown";
  }

  const reworked = new Map<number, number>();
  for (const interaction of interactions) {
    reworked.set(
      interaction.sourcePr,
      (reworked.get(interaction.sourcePr) ?? 0) + interaction.lines,
    );
  }
  for (const pr of analyses) {
    pr.reworkedLines = reworked.get(pr.number) ?? 0;
  }

  return { prs: analyses, interactions };
}

/**
 * Coder labels for every PR in the attribution context, using only signals
 * that survive in git: the branch name embedded in a merge commit's subject,
 * and the commit-message trailers of a squashed commit. No API calls, so
 * widening the context window stays cheap.
 */
async function resolveContextCoders(
  ctx: GitContext,
  context: readonly MergedPr[],
  concurrency: number,
  coderRules?: CoderRule[],
): Promise<Map<number, string>> {
  const entries = await mapLimit(context, concurrency, async (merge) => {
    const headRefName = headRefFromMergeSubject(merge.subject);
    const message = await commitMessage(ctx, merge.sha);
    const coder = detectCoder(
      { headRefName, commitMessages: [message], authorLogin: null },
      coderRules,
    );
    return [merge.number, coder] as const;
  });
  return new Map(entries);
}

/**
 * Map every commit reachable from a PR merge back to that PR, so blame output
 * can be attributed. For merge commits this walks the branch's own commits;
 * for squashes the single commit is the whole PR.
 */
async function buildShaToPrMap(
  ctx: GitContext,
  merges: readonly MergedPr[],
  concurrency: number,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  await mapLimit(merges, concurrency, async (merge) => {
    map.set(merge.sha, merge.number);
    if (merge.kind === "merge" && merge.parents.length >= 2) {
      const branchCommits = await commitsBetween(ctx, merge.parents[0], merge.parents[1]);
      for (const sha of branchCommits) map.set(sha, merge.number);
    }
  });
  return map;
}

interface AnalyzePrInput {
  ctx: GitContext;
  repo: RepoRef;
  merge: MergedPr;
  meta?: { metadata: PrMetadata | null; commitMessages: string[] };
  shaToPr: Map<string, number>;
  mergedAtByPr: Map<number, Date>;
  coderRules?: CoderRule[];
  interactions: Interaction[];
  /** PRs whose branch could not be reconstructed, so conflicts are unknown. */
  uninspected: number[];
}

async function analyzePr(input: AnalyzePrInput): Promise<PrAnalysis> {
  const { ctx, merge, meta, shaToPr, mergedAtByPr, interactions } = input;
  const base = diffBaseOf(merge);
  const metadata = meta?.metadata ?? null;

  const stats = await numstat(ctx, base, merge.sha);
  const files = stats.map((entry) => entry.path);
  const additions = stats.reduce((sum, e) => sum + (e.additions ?? 0), 0);
  const deletions = stats.reduce((sum, e) => sum + (e.deletions ?? 0), 0);

  const { rewrittenLines, rewrittenFreshLines } = await attributeRewrites({
    ctx,
    merge,
    base,
    shaToPr,
    mergedAtByPr,
    interactions,
  });

  const conflictResult = await detectConflicts(ctx, merge);
  if (!conflictResult.inspected) input.uninspected.push(merge.number);

  const coderMessages =
    meta?.commitMessages && meta.commitMessages.length > 0
      ? meta.commitMessages
      : [await commitMessage(ctx, merge.sha)];

  const coder = detectCoder(
    {
      headRefName: metadata?.headRefName ?? null,
      commitMessages: coderMessages,
      authorLogin: metadata?.authorLogin ?? null,
    },
    input.coderRules,
  );

  const createdAt = metadata?.createdAt || null;
  const timeToMergeHours =
    createdAt && metadata?.mergedAt
      ? Math.round(
          ((new Date(metadata.mergedAt).getTime() - new Date(createdAt).getTime()) / 3_600_000) *
            100,
        ) / 100
      : null;

  return {
    number: merge.number,
    sha: merge.sha,
    kind: merge.kind,
    title: metadata?.title || merge.subject,
    coder,
    authorLogin: metadata?.authorLogin ?? "",
    headRefName: metadata?.headRefName ?? "",
    createdAt,
    mergedAt: merge.mergedAt,
    timeToMergeHours,
    // Prefer git's own numbers: GitHub's additions/deletions describe the PR
    // branch, while the diff against the merge base describes what actually
    // landed on the trunk. They differ whenever a branch was updated.
    additions,
    deletions,
    changedFiles: files.length,
    files,
    commits: metadata?.commits ?? 1,
    branchUpdates: metadata?.branchUpdates ?? 0,
    forcePushes: metadata?.forcePushes ?? 0,
    reviews: metadata?.reviews ?? 0,
    comments: metadata?.comments ?? 0,
    failingChecksAtMerge: metadata?.failingChecksAtMerge ?? 0,
    conflicts: conflictResult.events,
    rewrittenLines,
    rewrittenFreshLines,
    reworkedLines: 0,
  };
}

async function attributeRewrites(args: {
  ctx: GitContext;
  merge: MergedPr;
  base: string;
  shaToPr: Map<string, number>;
  mergedAtByPr: Map<number, Date>;
  interactions: Interaction[];
}): Promise<{ rewrittenLines: number; rewrittenFreshLines: number }> {
  const { ctx, merge, base, shaToPr, mergedAtByPr, interactions } = args;
  const diffFiles = await unifiedZeroDiff(ctx, base, merge.sha);
  const mergedAt = new Date(merge.mergedAt);

  let rewrittenLines = 0;
  let rewrittenFreshLines = 0;
  const perSourceFile = new Map<string, { lines: number; sourcePr: number; file: string }>();

  for (const file of diffFiles) {
    if (file.binary || !file.oldPath) continue;
    const lineNumbers = oldSideLineNumbers(file);
    if (lineNumbers.length === 0) continue;
    rewrittenLines += lineNumbers.length;
    if (isUninterestingPath(file.oldPath)) continue;

    const blame = await blameLineCommits(ctx, base, file.oldPath);
    if (!blame) continue;

    for (const lineNumber of lineNumbers) {
      const sha = blame.get(lineNumber);
      if (!sha) continue;
      const sourcePr = shaToPr.get(sha);
      if (sourcePr === undefined || sourcePr === merge.number) continue;
      const key = `${sourcePr} ${file.oldPath}`;
      const entry = perSourceFile.get(key) ?? {
        lines: 0,
        sourcePr,
        file: file.oldPath,
      };
      entry.lines++;
      perSourceFile.set(key, entry);
    }
  }

  for (const entry of perSourceFile.values()) {
    const sourceMergedAt = mergedAtByPr.get(entry.sourcePr);
    if (!sourceMergedAt) continue;
    const ageDays = (mergedAt.getTime() - sourceMergedAt.getTime()) / 86_400_000;
    if (ageDays <= 3) rewrittenFreshLines += entry.lines;
    interactions.push({
      sourcePr: entry.sourcePr,
      targetPr: merge.number,
      file: entry.file,
      lines: entry.lines,
      ageDays: Math.round(ageDays * 100) / 100,
      sourceCoder: "unknown",
      targetCoder: "unknown",
    });
  }

  return { rewrittenLines, rewrittenFreshLines };
}

/**
 * Replay every merge the PR performed: the branch updates it took from the
 * trunk while open, and the final merge itself. Conflicts resolved inside the
 * branch are invisible in the final history but are real coordination cost.
 *
 * A squash-merged PR is the case worth spelling out. Its branch commits are
 * unreachable from the trunk — the trunk has one flattened commit — so walking
 * parents finds nothing and the PR looks conflict-free. The branch survives
 * only as the PR head ref, which is why the mirror fetches those refs; without
 * this path, every conflict in a squash-merging repo reads as zero.
 */
async function detectConflicts(
  ctx: GitContext,
  merge: MergedPr,
): Promise<{ events: ConflictEvent[]; inspected: boolean }> {
  const events: ConflictEvent[] = [];

  const branch = await resolveBranchRange(ctx, merge);
  if (!branch) {
    return { events, inspected: false };
  }

  const branchCommits = await commitsBetween(ctx, branch.base, branch.tip);
  for (const sha of branchCommits) {
    const parents = await parentsOf(ctx, sha);
    if (!parents || parents.length < 2) continue;
    const replay = await replayMerge(ctx, parents[0], parents[1]);
    if (replay.conflicted) {
      events.push({
        where: "branch-update",
        commit: sha.slice(0, 10),
        headline: (await commitMessage(ctx, sha)).split("\n")[0].slice(0, 120),
        files: replay.files,
      });
    }
  }

  // Only a real merge commit has a final merge to replay; a squash was
  // flattened by GitHub, which refuses to squash a conflicting PR at all.
  if (merge.kind === "merge" && merge.parents.length >= 2) {
    const finalReplay = await replayMerge(ctx, merge.parents[0], merge.parents[1]);
    if (finalReplay.conflicted) {
      events.push({
        where: "final-merge",
        commit: merge.sha.slice(0, 10),
        headline: merge.subject.slice(0, 120),
        files: finalReplay.files,
      });
    }
  }

  return { events, inspected: true };
}

/** The commit range holding a PR's own work, for either merge style. */
async function resolveBranchRange(
  ctx: GitContext,
  merge: MergedPr,
): Promise<{ base: string; tip: string } | null> {
  if (merge.kind === "merge" && merge.parents.length >= 2) {
    return { base: merge.parents[0], tip: merge.parents[1] };
  }

  const headRef = `refs/prs/${merge.number}`;
  if (!(await revExists(ctx, headRef))) return null;
  const trunkParent = merge.parents[0];
  if (!trunkParent) return null;
  const base = await mergeBase(ctx, trunkParent, headRef);
  if (!base) return null;
  return { base, tip: headRef };
}
