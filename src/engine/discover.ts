/**
 * Finding PR merges in the trunk's first-parent history.
 *
 * Two shapes have to be recognised, because a repo that uses both produces a
 * history where half the PRs are merge commits and half are single commits:
 *
 *   merge  — "Merge pull request #123 from owner/branch" with two parents
 *   squash — "feat(x): whatever (#123)" with one parent
 *
 * First-parent traversal is what makes this correct: it walks trunk commits
 * only, so a branch's internal commits never masquerade as separate merges.
 */
import type { MergedPr } from "./types";

const MERGE_SUBJECT = /^Merge pull request #(\d+)\b/;
const SQUASH_SUBJECT = /\(#(\d+)\)\s*$/;

export interface RawCommit {
  sha: string;
  parents: string[];
  committedAt: string;
  subject: string;
}

/** Parse `git log --pretty=%H|%P|%cI|%s` output. */
export function parseLogLines(stdout: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const [sha, parents, committedAt] = parts;
    const subject = parts.slice(3).join("|");
    commits.push({
      sha,
      parents: parents.split(" ").filter(Boolean),
      committedAt,
      subject,
    });
  }
  return commits;
}

/** Identify which first-parent commits are PR merges. Newest first. */
export function findPrMerges(commits: readonly RawCommit[]): MergedPr[] {
  const merges: MergedPr[] = [];
  for (const commit of commits) {
    const asMerge = MERGE_SUBJECT.exec(commit.subject);
    if (asMerge && commit.parents.length >= 2) {
      merges.push({
        number: Number(asMerge[1]),
        sha: commit.sha,
        parents: commit.parents,
        mergedAt: commit.committedAt,
        kind: "merge",
        subject: commit.subject,
      });
      continue;
    }
    const asSquash = SQUASH_SUBJECT.exec(commit.subject);
    if (asSquash) {
      merges.push({
        number: Number(asSquash[1]),
        sha: commit.sha,
        parents: commit.parents,
        mergedAt: commit.committedAt,
        kind: "squash",
        subject: commit.subject,
      });
    }
  }
  return merges;
}

/**
 * The base a PR's changes should be diffed against: its first parent for a
 * merge commit, the single parent for a squash.
 */
export function diffBaseOf(merge: MergedPr): string {
  return merge.parents.length >= 1 ? merge.parents[0] : `${merge.sha}^`;
}

/**
 * Recover the head branch name from a merge commit's subject.
 *
 * "Merge pull request #894 from owner/claude/devplan-arch" -> "claude/devplan-arch".
 *
 * This matters for attribution: PRs outside the analysed window still author
 * lines that in-window PRs rewrite, and without a coder for them every such
 * rewrite looks like it crossed agents. The subject is the only place the
 * branch name survives in git for a merge commit.
 */
export function headRefFromMergeSubject(subject: string): string | null {
  const match = /^Merge pull request #\d+ from (\S+)/.exec(subject);
  if (!match) return null;
  const path = match[1];
  const slash = path.indexOf("/");
  // Strip the owner segment: "owner/claude/x" -> "claude/x".
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Trunk commits carrying no PR reference at all — direct pushes. */
export function findDirectPushes(commits: readonly RawCommit[]): RawCommit[] {
  return commits.filter(
    (c) =>
      !(MERGE_SUBJECT.test(c.subject) && c.parents.length >= 2) &&
      !SQUASH_SUBJECT.test(c.subject),
  );
}

export interface WindowSelection {
  selected: MergedPr[];
  /** Merges kept in view for attribution but not themselves analysed. */
  context: MergedPr[];
}

/**
 * Choose the PRs to analyse.
 *
 * `context` matters: attributing a rewritten line to the PR that wrote it needs
 * a blame map covering PRs *older* than the window, otherwise every line looks
 * like it came from nowhere. The context set is deliberately wider than the
 * selection.
 */
export function selectWindow(
  merges: readonly MergedPr[],
  options: { count?: number; since?: Date; contextMultiplier?: number },
): WindowSelection {
  const multiplier = options.contextMultiplier ?? 5;
  let selected: MergedPr[];
  if (options.since) {
    const cutoff = options.since.getTime();
    selected = merges.filter((m) => new Date(m.mergedAt).getTime() >= cutoff);
  } else {
    const count = options.count ?? 50;
    selected = merges.slice(0, count);
  }
  const contextSize = Math.max(selected.length * multiplier, selected.length + 50);
  return { selected, context: merges.slice(0, contextSize) };
}
