import { describe, expect, it } from "vitest";

import {
  churnVerdict,
  conflictVerdict,
  escapeHtml,
  formatNumber,
  renderReportHtml,
  share,
} from "./html";
import { buildReport } from "../engine/metrics";
import type { Interaction, PrAnalysis } from "../engine/types";

function pr(overrides: Partial<PrAnalysis> & { number: number }): PrAnalysis {
  return {
    sha: "abc",
    kind: "squash",
    title: "feat: thing",
    coder: "claude",
    authorLogin: "someone",
    headRefName: "claude/x",
    createdAt: "2026-08-01T10:00:00Z",
    mergedAt: "2026-08-01T11:00:00Z",
    timeToMergeHours: 1,
    additions: 100,
    deletions: 10,
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
    ...overrides,
  };
}

function makeReport(prs: PrAnalysis[], interactions: Interaction[] = []) {
  return buildReport({
    prs,
    interactions,
    repos: ["owner/repo"],
    coderFilter: null,
    warnings: [],
    generatedAt: "2026-08-08T00:00:00Z",
    window: {
      mode: "count",
      requested: prs.length,
      firstMergedAt: "2026-08-01T00:00:00Z",
      lastMergedAt: "2026-08-02T00:00:00Z",
      spanDays: 1,
    },
  });
}

describe("escapeHtml", () => {
  it("neutralises markup from titles and branch names", () => {
    expect(escapeHtml('<img src=x onerror="y">')).toBe(
      "&lt;img src=x onerror=&quot;y&quot;&gt;",
    );
  });
});

describe("share", () => {
  it("formats a percentage", () => {
    expect(share(25, 100)).toBe("25%");
  });

  it("returns 0% rather than NaN when the total is zero", () => {
    expect(share(0, 0)).toBe("0%");
  });
});

describe("verdict thresholds", () => {
  it("grades conflict rate", () => {
    expect(conflictVerdict(2)).toBe("good");
    expect(conflictVerdict(10)).toBe("warn");
    expect(conflictVerdict(40)).toBe("bad");
  });

  it("grades churn rate", () => {
    expect(churnVerdict(3)).toBe("good");
    expect(churnVerdict(30)).toBe("bad");
  });
});

describe("renderReportHtml", () => {
  it("produces a self-contained page with no external requests", () => {
    const html = renderReportHtml(makeReport([pr({ number: 1 })]));
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<script\b/);
    expect(html).not.toMatch(/src=["']https?:/);
    expect(html).not.toMatch(/<link\b/);
  });

  it("escapes a hostile PR title rather than emitting it raw", () => {
    const html = renderReportHtml(
      makeReport([pr({ number: 1, title: "<script>alert(1)</script>" })]),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("links PR numbers when the report covers a single repo", () => {
    const html = renderReportHtml(makeReport([pr({ number: 42 })]));
    expect(html).toContain("https://github.com/owner/repo/pull/42");
  });

  it("separates fresh cross-agent overwrites from ordinary maintenance", () => {
    const interactions: Interaction[] = [
      { sourcePr: 2, targetPr: 1, file: "a.ts", lines: 900, ageDays: 60, sourceCoder: "codex", targetCoder: "claude" },
      { sourcePr: 3, targetPr: 1, file: "a.ts", lines: 5, ageDays: 0.2, sourceCoder: "codex", targetCoder: "claude" },
    ];
    const report = makeReport([pr({ number: 1 })], interactions);
    expect(report.metrics.crossCoderOverwriteLines).toBe(905);
    expect(report.metrics.crossCoderFreshOverwriteLines).toBe(5);
    const html = renderReportHtml(report);
    expect(html).toContain("905");
    expect(html).toContain("the racing kind");
  });

  it("renders an empty window without throwing", () => {
    const html = renderReportHtml(makeReport([]));
    expect(html).toContain("Merge health of 0 PR merges");
  });

  it("surfaces coverage warnings instead of hiding them", () => {
    const report = makeReport([pr({ number: 1 })]);
    report.warnings.push("2 squash-merged PR(s) had no reachable branch");
    const html = renderReportHtml(report);
    expect(html).toContain("Coverage notes");
    expect(html).toContain("no reachable branch");
  });
});

describe("formatNumber", () => {
  it("groups thousands", () => {
    expect(formatNumber(168393)).toBe("168,393");
  });
});
