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
