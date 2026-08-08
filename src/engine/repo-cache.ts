/**
 * Local mirror-clone cache.
 *
 * The valuable metrics — who overwrote whose lines, which merges actually
 * conflicted — need real git object access, not the REST API. A `--mirror`
 * clone gives that without a working tree: `git blame <rev> -- <path>` and
 * `git merge-tree` both work fine in a bare repository, and the mirror keeps
 * every remote ref including the PR head refs (`refs/pull/<n>/head`), which is
 * how PR branches are replayed for conflict detection.
 *
 * Clones are cached and incrementally fetched, so the first run on a repo is
 * slow and every later one is cheap.
 */
import { existsSync } from "node:fs";
import { run, runOrThrow } from "./exec";
import { clonePath, ensureDir, clonesDir } from "./paths";
import type { RepoRef } from "./types";

export interface CloneProgress {
  (message: string): void;
}

/**
 * Ensure a mirror of `repo` exists locally and is up to date. Returns the path
 * to the bare repository.
 */
export async function ensureMirror(
  repo: RepoRef,
  onProgress: CloneProgress = () => {},
): Promise<string> {
  ensureDir(clonesDir());
  const path = clonePath(repo.owner, repo.name);
  const url = `https://github.com/${repo.owner}/${repo.name}.git`;

  if (!existsSync(path)) {
    onProgress(`cloning ${repo.owner}/${repo.name} (first run, this is the slow one)`);
    await runOrThrow("git", ["clone", "--mirror", url, path]);
  } else {
    onProgress(`fetching ${repo.owner}/${repo.name}`);
    const fetched = await run("git", ["--git-dir", path, "fetch", "--prune", "origin"], {});
    if (fetched.code !== 0) {
      throw new Error(
        `fetch_failed:${repo.owner}/${repo.name}: ${fetched.stderr.slice(0, 300)}`,
      );
    }
  }

  // PR head refs are not part of a default mirror's refspec. They are what
  // makes conflict replay possible for squash-merged PRs, whose branch commits
  // are otherwise unreachable from the trunk.
  await run("git", [
    "--git-dir",
    path,
    "fetch",
    "--no-tags",
    "--force",
    "origin",
    "+refs/pull/*/head:refs/prs/*",
  ]);

  return path;
}

/** The trunk ref inside a mirror, e.g. `refs/heads/main`. */
export async function defaultBranch(gitDir: string): Promise<string> {
  const head = await run("git", ["--git-dir", gitDir, "symbolic-ref", "HEAD"]);
  if (head.code === 0 && head.stdout.trim()) {
    return head.stdout.trim();
  }
  for (const candidate of ["refs/heads/main", "refs/heads/master"]) {
    const exists = await run("git", ["--git-dir", gitDir, "rev-parse", "--verify", candidate]);
    if (exists.code === 0) return candidate;
  }
  throw new Error("default_branch_not_found");
}

export async function mirrorExists(repo: RepoRef): Promise<boolean> {
  return existsSync(clonePath(repo.owner, repo.name));
}
