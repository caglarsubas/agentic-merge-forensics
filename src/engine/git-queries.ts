/**
 * The git calls the analysis is built on. Thin wrappers, so the interesting
 * logic stays in pure modules that can be tested without a repository.
 */
import { run } from "./exec";
import { parseLogLines, type RawCommit } from "./discover";
import { parseNumstat, parseUnifiedZeroDiff, type DiffFile, type NumstatEntry } from "./diff";

export interface GitContext {
  gitDir: string;
}

const git = (ctx: GitContext, args: string[]) =>
  run("git", ["--git-dir", ctx.gitDir, ...args]);

/** First-parent trunk history, newest first. */
export async function firstParentLog(
  ctx: GitContext,
  ref: string,
  limit: number,
): Promise<RawCommit[]> {
  const result = await git(ctx, [
    "log",
    "--first-parent",
    `-n${limit}`,
    "--pretty=%H|%P|%cI|%s",
    ref,
  ]);
  if (result.code !== 0) throw new Error(`git_log_failed: ${result.stderr.slice(0, 300)}`);
  return parseLogLines(result.stdout);
}

export async function numstat(
  ctx: GitContext,
  base: string,
  head: string,
): Promise<NumstatEntry[]> {
  const result = await git(ctx, ["diff", "-M", "--numstat", base, head]);
  if (result.code !== 0) return [];
  return parseNumstat(result.stdout);
}

export async function unifiedZeroDiff(
  ctx: GitContext,
  base: string,
  head: string,
): Promise<DiffFile[]> {
  const result = await git(ctx, ["diff", "-M", "-U0", "--no-color", base, head]);
  if (result.code !== 0) return [];
  return parseUnifiedZeroDiff(result.stdout);
}

/**
 * Blame a file at a revision, returning line number -> authoring commit.
 * `--line-porcelain` is verbose but is the only format that reliably gives the
 * final line number alongside the commit for every line.
 */
export async function blameLineCommits(
  ctx: GitContext,
  rev: string,
  path: string,
): Promise<Map<number, string> | null> {
  const result = await git(ctx, ["blame", "--line-porcelain", rev, "--", path]);
  if (result.code !== 0) return null;
  const map = new Map<number, string>();
  for (const line of result.stdout.split("\n")) {
    const match = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
    if (match) map.set(Number(match[3]), match[1]);
  }
  return map;
}

export async function parentsOf(ctx: GitContext, sha: string): Promise<string[] | null> {
  const result = await git(ctx, ["rev-list", "--parents", "-n", "1", sha]);
  if (result.code !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim().split(/\s+/).slice(1);
}

/** Commits reachable from `head` but not `base` — a PR branch's own commits. */
export async function commitsBetween(
  ctx: GitContext,
  base: string,
  head: string,
): Promise<string[]> {
  const result = await git(ctx, ["rev-list", head, `^${base}`]);
  if (result.code !== 0) return [];
  return result.stdout.split("\n").filter(Boolean);
}

export async function commitMessage(ctx: GitContext, sha: string): Promise<string> {
  const result = await git(ctx, ["log", "-1", "--pretty=%B", sha]);
  return result.code === 0 ? result.stdout : "";
}

export async function commitSubject(ctx: GitContext, sha: string): Promise<string> {
  const result = await git(ctx, ["log", "-1", "--pretty=%s", sha]);
  return result.code === 0 ? result.stdout.trim() : "";
}

export async function revExists(ctx: GitContext, rev: string): Promise<boolean> {
  const result = await git(ctx, ["rev-parse", "--verify", "--quiet", rev]);
  return result.code === 0 && Boolean(result.stdout.trim());
}

export async function mergeBase(
  ctx: GitContext,
  a: string,
  b: string,
): Promise<string | null> {
  const result = await git(ctx, ["merge-base", a, b]);
  if (result.code !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim();
}

export interface MergeReplay {
  conflicted: boolean;
  files: string[];
  /** True when the replay could not run at all (missing objects, old git). */
  unavailable: boolean;
}

/**
 * Replay a merge without touching a working tree.
 *
 * `git merge-tree --write-tree` exits 0 for a clean merge and 1 when the merge
 * conflicts, printing the conflicted paths. That is what makes it possible to
 * detect conflicts that were resolved inside a branch long before the PR was
 * merged — the kind GitHub never shows and the final history hides.
 *
 * Requires git >= 2.38. Older git exits with a different code and no file
 * list, which is reported as `unavailable` rather than silently as "clean".
 */
export async function replayMerge(
  ctx: GitContext,
  a: string,
  b: string,
): Promise<MergeReplay> {
  const result = await git(ctx, ["merge-tree", "--write-tree", "--name-only", a, b]);
  if (result.code === 0) {
    return { conflicted: false, files: [], unavailable: false };
  }
  if (result.code === 1) {
    // Output is the resulting tree oid, a blank line, then conflicted paths.
    const lines = result.stdout.split("\n");
    const files: string[] = [];
    for (const line of lines.slice(1)) {
      if (line === "") break;
      files.push(line);
    }
    return { conflicted: true, files: [...new Set(files)].sort(), unavailable: false };
  }
  return { conflicted: false, files: [], unavailable: true };
}

/** git version as [major, minor], for capability checks. */
export async function gitVersion(): Promise<[number, number]> {
  const result = await run("git", ["--version"]);
  const match = /(\d+)\.(\d+)/.exec(result.stdout);
  if (!match) return [0, 0];
  return [Number(match[1]), Number(match[2])];
}
