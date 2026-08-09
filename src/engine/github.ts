/**
 * PR metadata via the `gh` CLI.
 *
 * `gh` is used rather than a raw token so the tool inherits whatever auth the
 * user already has, including SSO and enterprise hosts. Every field here is
 * optional to the analysis: when `gh` is missing or unauthenticated the run
 * still produces all the git-derived metrics and records a warning, because a
 * degraded report beats a failed one.
 */
import { run, mapLimit } from "./exec";
import type { PrMetadata, RepoRef } from "./types";
import { repoSlug } from "./types";

const PR_FIELDS = [
  "number",
  "title",
  "author",
  "createdAt",
  "mergedAt",
  "additions",
  "deletions",
  "changedFiles",
  "headRefName",
  "commits",
  "reviews",
  "comments",
  "statusCheckRollup",
].join(",");

export async function ghAvailable(): Promise<boolean> {
  const result = await run("gh", ["--version"]);
  return result.code === 0;
}

export async function ghAuthenticated(): Promise<boolean> {
  const result = await run("gh", ["auth", "status"]);
  return result.code === 0;
}

interface RawPr {
  number: number;
  title?: string;
  author?: { login?: string };
  createdAt?: string;
  mergedAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  headRefName?: string;
  commits?: Array<{ oid?: string; messageHeadline?: string; messageBody?: string }>;
  reviews?: unknown[];
  comments?: unknown[];
  statusCheckRollup?: Array<{ conclusion?: string; state?: string }>;
}

export interface PrFetchResult {
  metadata: PrMetadata | null;
  /** Full commit messages, used for coder trailers. */
  commitMessages: string[];
  error?: string;
}

const BRANCH_UPDATE = /^Merge (branch|remote-tracking branch) /;

export async function fetchPr(repo: RepoRef, number: number): Promise<PrFetchResult> {
  const view = await run("gh", [
    "pr",
    "view",
    String(number),
    "--repo",
    repoSlug(repo),
    "--json",
    PR_FIELDS,
  ]);
  if (view.code !== 0) {
    return { metadata: null, commitMessages: [], error: view.stderr.slice(0, 200) };
  }

  let raw: RawPr;
  try {
    raw = JSON.parse(view.stdout) as RawPr;
  } catch {
    return { metadata: null, commitMessages: [], error: "unparseable_gh_json" };
  }

  const commits = raw.commits ?? [];
  const commitMessages = commits.map((c) =>
    [c.messageHeadline ?? "", c.messageBody ?? ""].join("\n"),
  );
  const branchUpdates = commits.filter((c) =>
    BRANCH_UPDATE.test(c.messageHeadline ?? ""),
  ).length;

  let failing = 0;
  for (const check of raw.statusCheckRollup ?? []) {
    const verdict = (check.conclusion || check.state || "").toUpperCase();
    if (verdict === "FAILURE" || verdict === "ERROR" || verdict === "TIMED_OUT") failing++;
  }

  const forcePushes = await countForcePushes(repo, number);

  return {
    commitMessages,
    metadata: {
      number: raw.number,
      title: raw.title ?? "",
      authorLogin: raw.author?.login ?? "",
      headRefName: raw.headRefName ?? "",
      createdAt: raw.createdAt ?? "",
      mergedAt: raw.mergedAt ?? "",
      additions: raw.additions ?? 0,
      deletions: raw.deletions ?? 0,
      changedFiles: raw.changedFiles ?? 0,
      commits: commits.length,
      branchUpdates,
      forcePushes,
      reviews: (raw.reviews ?? []).length,
      comments: (raw.comments ?? []).length,
      failingChecksAtMerge: failing,
    },
  };
}

/**
 * Force-pushes matter because a conflict resolved during a rebase leaves no
 * trace in history — it is the main reason the measured conflict rate is a
 * floor rather than an exact figure, so it is worth counting explicitly.
 */
async function countForcePushes(repo: RepoRef, number: number): Promise<number> {
  const timeline = await run("gh", [
    "api",
    "--paginate",
    `repos/${repoSlug(repo)}/issues/${number}/timeline`,
    "--jq",
    ".[] | .event",
  ]);
  if (timeline.code !== 0) return 0;
  return timeline.stdout
    .split("\n")
    .filter((event) => event.trim() === "head_ref_force_pushed").length;
}

export async function fetchPrs(
  repo: RepoRef,
  numbers: readonly number[],
  concurrency = 6,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<Map<number, PrFetchResult>> {
  let done = 0;
  const results = await mapLimit(numbers, concurrency, async (number) => {
    const result = await fetchPr(repo, number);
    onProgress(++done, numbers.length);
    return [number, result] as const;
  });
  return new Map(results);
}

export interface RemoteRepo {
  /** `owner/name`, exactly the form the analysis takes. */
  slug: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  /** ISO timestamp of the last push, or null if GitHub omitted it. */
  pushedAt: string | null;
}

export interface RepoListResult {
  repos: RemoteRepo[];
  /** True when the account has more repos than the page cap below. */
  truncated: boolean;
  /** Set when `gh` is missing, unauthenticated, or the API failed. */
  error?: string;
}

interface RawRepo {
  full_name?: string;
  owner?: { login?: string };
  name?: string;
  private?: boolean;
  archived?: boolean;
  fork?: boolean;
  pushed_at?: string | null;
}

const REPO_PAGE_SIZE = 100;
/** Bounds the wait on accounts with thousands of repos; sorted by push date,
 *  so what gets dropped is the long-dormant tail rather than anything active. */
const REPO_MAX_PAGES = 3;

/**
 * Repositories the authenticated user can reach — their own, ones they
 * collaborate on, and their orgs' — most recently pushed first.
 *
 * Errors are returned rather than thrown: the repo field stays usable by hand
 * when `gh` is absent, so a failure here should degrade the picker, not the page.
 */
export async function listAccessibleRepos(): Promise<RepoListResult> {
  if (!(await ghAvailable())) {
    return { repos: [], truncated: false, error: "gh is not installed" };
  }
  if (!(await ghAuthenticated())) {
    return { repos: [], truncated: false, error: "gh is not authenticated" };
  }

  const repos: RemoteRepo[] = [];
  let truncated = false;

  for (let page = 1; page <= REPO_MAX_PAGES; page++) {
    const result = await run("gh", [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `/user/repos?per_page=${REPO_PAGE_SIZE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
    ]);
    if (result.code !== 0) {
      return {
        repos,
        truncated,
        error: result.stderr.trim().slice(0, 200) || "gh api failed",
      };
    }

    let raw: RawRepo[];
    try {
      raw = JSON.parse(result.stdout) as RawRepo[];
    } catch {
      return { repos, truncated, error: "could not parse gh api output" };
    }
    if (!Array.isArray(raw)) return { repos, truncated, error: "unexpected gh api output" };

    for (const entry of raw) {
      const slug = entry.full_name ?? "";
      const owner = entry.owner?.login ?? slug.split("/")[0] ?? "";
      const name = entry.name ?? slug.split("/")[1] ?? "";
      if (!owner || !name) continue;
      repos.push({
        slug: slug || `${owner}/${name}`,
        owner,
        name,
        isPrivate: Boolean(entry.private),
        isArchived: Boolean(entry.archived),
        isFork: Boolean(entry.fork),
        pushedAt: entry.pushed_at ?? null,
      });
    }

    if (raw.length < REPO_PAGE_SIZE) return { repos, truncated: false };
    if (page === REPO_MAX_PAGES) truncated = true;
  }

  return { repos, truncated };
}
