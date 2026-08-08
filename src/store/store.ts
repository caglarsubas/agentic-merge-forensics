/**
 * Run history and scheduler state.
 *
 * Plain JSON files rather than a database: the whole point of the local-only
 * mode is that a user can open, diff, back up or delete this by hand, and a
 * native SQLite dependency would be one more thing to build per platform. The
 * volumes here are small — one summary per run.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureDir, ensureHomeLayout, reportsDir, stateDir } from "../engine/paths";
import type { ForensicsReport } from "../engine/types";

export interface RunSummary {
  id: string;
  generatedAt: string;
  repos: string[];
  coderFilter: string[] | null;
  prCount: number;
  prNumbers: number[];
  conflictRatePct: number;
  conflictedPrs: number[];
  churnRatePct: number;
  crossCoderFreshOverwriteLines: number;
  mergesPerDay: number;
  medianTimeToMergeHours: number;
  reverts: number;
  htmlPath: string;
  jsonPath: string;
}

/** Watermark for "alert me every N merges" scheduling, per repo set. */
export interface Watermark {
  key: string;
  /** Highest PR number seen at the last alert. */
  lastPrNumber: number;
  lastRunAt: string;
  lastAlertAt: string | null;
  mergesSinceAlert: number;
}

function runsIndexPath(): string {
  return join(stateDir(), "runs.json");
}

function watermarksPath(): string {
  return join(stateDir(), "watermarks.json");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // A truncated file from an interrupted write should not brick the tool.
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  // Write-then-rename so a crash mid-write cannot leave a half-file behind.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(temporary, path);
  } catch {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** A stable id per run: sortable by time, unique per repo set. */
export function makeRunId(report: ForensicsReport, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const slug = report.repos
    .map((repo) => repo.replace("/", "__"))
    .join("+")
    .slice(0, 60);
  return `${stamp}_${slug}`;
}

export function summarize(report: ForensicsReport, id: string, paths: {
  htmlPath: string;
  jsonPath: string;
}): RunSummary {
  return {
    id,
    generatedAt: report.generatedAt,
    repos: report.repos,
    coderFilter: report.coderFilter,
    prCount: report.prCount,
    prNumbers: report.prs.map((pr) => pr.number),
    conflictRatePct: report.metrics.conflictRatePct,
    conflictedPrs: report.metrics.conflictedPrs,
    churnRatePct: report.metrics.churnRatePct,
    crossCoderFreshOverwriteLines: report.metrics.crossCoderFreshOverwriteLines,
    mergesPerDay: report.metrics.mergesPerDay,
    medianTimeToMergeHours: report.metrics.timeToMergeHours.median,
    reverts: report.metrics.reverts.length,
    htmlPath: paths.htmlPath,
    jsonPath: paths.jsonPath,
  };
}

export interface SaveResult {
  id: string;
  htmlPath: string;
  jsonPath: string;
  summary: RunSummary;
}

export function saveRun(
  report: ForensicsReport,
  html: string,
  now: Date = new Date(),
): SaveResult {
  ensureHomeLayout();
  const id = makeRunId(report, now);
  const dir = ensureDir(join(reportsDir(), id));
  const htmlPath = join(dir, "report.html");
  const jsonPath = join(dir, "report.json");
  writeFileSync(htmlPath, html, "utf8");
  writeJson(jsonPath, report);

  const summary = summarize(report, id, { htmlPath, jsonPath });
  const runs = listRuns();
  writeJson(runsIndexPath(), [summary, ...runs.filter((run) => run.id !== id)]);
  return { id, htmlPath, jsonPath, summary };
}

export function listRuns(): RunSummary[] {
  return readJson<RunSummary[]>(runsIndexPath(), []);
}

export function getRun(id: string): RunSummary | null {
  return listRuns().find((run) => run.id === id) ?? null;
}

export function readRunReport(id: string): ForensicsReport | null {
  const run = getRun(id);
  if (!run || !existsSync(run.jsonPath)) return null;
  return readJson<ForensicsReport | null>(run.jsonPath, null);
}

export function readRunHtml(id: string): string | null {
  const run = getRun(id);
  if (!run || !existsSync(run.htmlPath)) return null;
  return readFileSync(run.htmlPath, "utf8");
}

/** Rebuild the index from disk, for when it is lost or edited by hand. */
export function reindexRuns(): RunSummary[] {
  ensureHomeLayout();
  const summaries: RunSummary[] = [];
  for (const entry of readdirSync(reportsDir(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = join(reportsDir(), entry.name, "report.json");
    const htmlPath = join(reportsDir(), entry.name, "report.html");
    if (!existsSync(jsonPath)) continue;
    const report = readJson<ForensicsReport | null>(jsonPath, null);
    if (!report) continue;
    summaries.push(summarize(report, entry.name, { htmlPath, jsonPath }));
  }
  summaries.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  writeJson(runsIndexPath(), summaries);
  return summaries;
}

export function watermarkKey(repos: string[], coders: string[] | null): string {
  return `${[...repos].sort().join("+")}::${coders ? [...coders].sort().join(",") : "all"}`;
}

export function readWatermarks(): Record<string, Watermark> {
  return readJson<Record<string, Watermark>>(watermarksPath(), {});
}

export function writeWatermark(mark: Watermark): void {
  ensureHomeLayout();
  const all = readWatermarks();
  all[mark.key] = mark;
  writeJson(watermarksPath(), all);
}
