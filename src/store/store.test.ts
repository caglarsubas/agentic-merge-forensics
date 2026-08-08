import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildReport } from "../engine/metrics";
import type { ForensicsReport, PrAnalysis } from "../engine/types";
import {
  listRuns,
  makeRunId,
  readRunHtml,
  readRunReport,
  reindexRuns,
  saveRun,
  watermarkKey,
  readWatermarks,
  writeWatermark,
} from "./store";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mf-store-"));
  process.env.MERGE_FORENSICS_HOME = home;
});

afterEach(() => {
  delete process.env.MERGE_FORENSICS_HOME;
  rmSync(home, { recursive: true, force: true });
});

function makeReport(repos = ["owner/repo"]): ForensicsReport {
  const pr: PrAnalysis = {
    number: 1,
    sha: "abc",
    kind: "squash",
    title: "feat: thing",
    coder: "claude",
    authorLogin: "someone",
    headRefName: "claude/x",
    createdAt: "2026-08-01T10:00:00Z",
    mergedAt: "2026-08-01T11:00:00Z",
    timeToMergeHours: 1,
    additions: 10,
    deletions: 1,
    changedFiles: 1,
    files: ["a.ts"],
    commits: 1,
    branchUpdates: 0,
    forcePushes: 0,
    reviews: 0,
    comments: 0,
    failingChecksAtMerge: 0,
    conflicts: [],
    rewrittenLines: 0,
    rewrittenFreshLines: 0,
    reworkedLines: 0,
  };
  return buildReport({
    prs: [pr],
    interactions: [],
    repos,
    coderFilter: null,
    warnings: [],
    generatedAt: "2026-08-08T00:00:00Z",
    window: {
      mode: "count",
      requested: 1,
      firstMergedAt: "2026-08-01T00:00:00Z",
      lastMergedAt: "2026-08-01T11:00:00Z",
      spanDays: 1,
    },
  });
}

describe("makeRunId", () => {
  it("is sortable by time and names the repos", () => {
    const id = makeRunId(makeReport(), new Date("2026-08-08T17:02:38Z"));
    expect(id).toBe("20260808-170238_owner__repo");
  });
});

describe("saveRun", () => {
  it("writes html and json and indexes the run", () => {
    const saved = saveRun(makeReport(), "<html>report</html>");
    expect(readRunHtml(saved.id)).toBe("<html>report</html>");
    expect(readRunReport(saved.id)?.prCount).toBe(1);
    expect(listRuns().map((run) => run.id)).toEqual([saved.id]);
  });

  it("lists the newest run first", () => {
    const first = saveRun(makeReport(["a/one"]), "<p>1</p>", new Date("2026-08-01T00:00:00Z"));
    const second = saveRun(makeReport(["a/two"]), "<p>2</p>", new Date("2026-08-02T00:00:00Z"));
    expect(listRuns().map((run) => run.id)).toEqual([second.id, first.id]);
  });

  it("returns null rather than throwing for an unknown id", () => {
    expect(readRunHtml("nope")).toBeNull();
    expect(readRunReport("nope")).toBeNull();
  });
});

describe("reindexRuns", () => {
  it("rebuilds the index from the report directories on disk", () => {
    const saved = saveRun(makeReport(), "<p>x</p>");
    // Simulate a lost or hand-edited index.
    rmSync(join(home, "state", "runs.json"), { force: true });
    expect(listRuns()).toEqual([]);
    expect(reindexRuns().map((run) => run.id)).toEqual([saved.id]);
  });
});

describe("watermarks", () => {
  it("keys on the repo set and coder filter together", () => {
    // Different filters over the same repos are different alert streams;
    // sharing a watermark would let one silence the other.
    expect(watermarkKey(["a/b"], null)).not.toBe(watermarkKey(["a/b"], ["claude"]));
    // Ordering must not create a second stream for the same selection.
    expect(watermarkKey(["a/b", "c/d"], null)).toBe(watermarkKey(["c/d", "a/b"], null));
  });

  it("round-trips through disk", () => {
    writeWatermark({
      key: "k",
      lastPrNumber: 42,
      lastRunAt: "2026-08-08T00:00:00Z",
      lastAlertAt: null,
      mergesSinceAlert: 3,
    });
    expect(readWatermarks().k.lastPrNumber).toBe(42);
  });
});
