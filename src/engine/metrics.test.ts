import { describe, expect, it } from "vitest";

import {
  ageBucket,
  buildReport,
  coderStats,
  concurrentPairs,
  distribution,
  hotFiles,
  overwriteSplit,
  quantile,
  titleTypes,
} from "./metrics";
import type { Interaction, PrAnalysis } from "./types";

function pr(overrides: Partial<PrAnalysis> & { number: number }): PrAnalysis {
  return {
    sha: `sha${overrides.number}`,
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

describe("quantile / distribution", () => {
  it("interpolates between samples", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it("summarises a set of values", () => {
    const d = distribution([1, 2, 3, 100]);
    expect(d.median).toBe(2.5);
    expect(d.max).toBe(100);
    expect(d.total).toBe(106);
  });

  it("returns zeroes rather than NaN for an empty set", () => {
    expect(distribution([])).toEqual({ median: 0, p90: 0, max: 0, mean: 0, total: 0 });
  });
});

describe("ageBucket", () => {
  it("bins by how old the rewritten code was", () => {
    expect(ageBucket(0.5)).toBe("<=1d");
    expect(ageBucket(1)).toBe("<=1d");
    expect(ageBucket(2)).toBe("1-3d");
    expect(ageBucket(30)).toBe(">14d");
  });
});

describe("overwriteSplit", () => {
  const interactions: Interaction[] = [
    { sourcePr: 1, targetPr: 2, file: "a", lines: 10, ageDays: 0.1, sourceCoder: "codex", targetCoder: "codex" },
    { sourcePr: 3, targetPr: 4, file: "b", lines: 5, ageDays: 0.2, sourceCoder: "claude", targetCoder: "codex" },
  ];

  it("separates an agent reworking its own code from crossing another's", () => {
    const split = overwriteSplit(interactions);
    expect(split.sameCoder).toBe(10);
    expect(split.crossCoder).toBe(5);
    expect(split.matrix["claude -> codex"]).toBe(5);
  });

  it("does not count an unidentified side as a cross-agent overwrite", () => {
    // Lines authored before the analysis window have no coder until one is
    // resolved. Treating unknown as "different" silently inflates the headline
    // cross-agent number with ordinary history.
    const split = overwriteSplit([
      { sourcePr: 9, targetPr: 2, file: "a", lines: 100, ageDays: 40, sourceCoder: "unknown", targetCoder: "codex" },
      ...interactions,
    ]);
    expect(split.unattributed).toBe(100);
    expect(split.crossCoder).toBe(5);
    expect(split.matrix["unknown -> codex"]).toBeUndefined();
  });

  it("restricts to fresh code when given an age bound", () => {
    // Rewriting month-old code across agents is maintenance; days-old is a race.
    const aged: Interaction[] = [
      { sourcePr: 1, targetPr: 2, file: "a", lines: 500, ageDays: 40, sourceCoder: "codex", targetCoder: "claude" },
      { sourcePr: 3, targetPr: 4, file: "b", lines: 7, ageDays: 0.5, sourceCoder: "codex", targetCoder: "claude" },
    ];
    expect(overwriteSplit(aged).crossCoder).toBe(507);
    expect(overwriteSplit(aged, 3).crossCoder).toBe(7);
  });
});

describe("concurrentPairs", () => {
  it("finds overlapping PRs that shared a file and tracks peak concurrency", () => {
    const prs = [
      pr({ number: 1, createdAt: "2026-08-01T00:00:00Z", mergedAt: "2026-08-01T04:00:00Z", files: ["x.ts"] }),
      pr({ number: 2, createdAt: "2026-08-01T02:00:00Z", mergedAt: "2026-08-01T06:00:00Z", files: ["x.ts"] }),
      pr({ number: 3, createdAt: "2026-08-01T03:00:00Z", mergedAt: "2026-08-01T05:00:00Z", files: ["y.ts"] }),
    ];
    const result = concurrentPairs(prs, new Set([2]));
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ a: 1, b: 2, sharedFiles: ["x.ts"], conflicted: true });
    expect(result.peakOpen).toBe(3);
  });

  it("does not pair PRs whose open intervals only touch at an instant", () => {
    const prs = [
      pr({ number: 1, createdAt: "2026-08-01T00:00:00Z", mergedAt: "2026-08-01T02:00:00Z" }),
      pr({ number: 2, createdAt: "2026-08-01T02:00:00Z", mergedAt: "2026-08-01T04:00:00Z" }),
    ];
    expect(concurrentPairs(prs, new Set()).pairs).toEqual([]);
  });
});

describe("hotFiles", () => {
  it("ranks by how many PRs touched a file", () => {
    const prs = [
      pr({ number: 1, files: ["shared.md", "a.ts"] }),
      pr({ number: 2, files: ["shared.md"] }),
      pr({ number: 3, files: ["shared.md"] }),
    ];
    const interactions: Interaction[] = [
      { sourcePr: 1, targetPr: 2, file: "shared.md", lines: 42, ageDays: 0.1, sourceCoder: "a", targetCoder: "b" },
    ];
    const hot = hotFiles(prs, interactions);
    expect(hot[0]).toMatchObject({ file: "shared.md", prCount: 3, crossPrLines: 42 });
  });
});

describe("coderStats / titleTypes", () => {
  it("aggregates per coder", () => {
    const stats = coderStats([
      pr({ number: 1, coder: "claude", title: "fix: a" }),
      pr({ number: 2, coder: "codex" }),
      pr({ number: 3, coder: "codex" }),
    ]);
    expect(stats[0]).toMatchObject({ coder: "codex", prs: 2 });
    expect(stats[1]).toMatchObject({ coder: "claude", fixPrs: 1 });
  });

  it("counts conventional-commit types", () => {
    expect(
      titleTypes([pr({ number: 1, title: "feat(x): a" }), pr({ number: 2, title: "no type here" })]),
    ).toEqual({ feat: 1, other: 1 });
  });
});

describe("buildReport", () => {
  const base = {
    repos: ["o/r"],
    coderFilter: null,
    warnings: [],
    generatedAt: "2026-08-08T00:00:00Z",
    window: {
      mode: "count" as const,
      requested: 2,
      firstMergedAt: "2026-08-01T00:00:00Z",
      lastMergedAt: "2026-08-02T00:00:00Z",
      spanDays: 1,
    },
  };

  it("computes conflict and churn rates against explicit denominators", () => {
    const prs = [
      pr({ number: 1, additions: 100 }),
      pr({
        number: 2,
        additions: 100,
        conflicts: [{ where: "final-merge", commit: "abc", headline: "x", files: ["a.ts"] }],
      }),
    ];
    const interactions: Interaction[] = [
      { sourcePr: 1, targetPr: 2, file: "a.ts", lines: 20, ageDays: 0.5, sourceCoder: "claude", targetCoder: "claude" },
    ];
    const report = buildReport({ ...base, prs, interactions });

    expect(report.metrics.conflictRatePct).toBe(50);
    expect(report.metrics.conflictedPrs).toEqual([2]);
    // 20 of 200 added lines were rewritten in-window.
    expect(report.metrics.churnRatePct).toBe(10);
    expect(report.metrics.sameCoderOverwriteLines).toBe(20);
    expect(report.metrics.crossCoderOverwriteLines).toBe(0);
  });

  it("reports zero rates rather than NaN when nothing was added", () => {
    const report = buildReport({ ...base, prs: [pr({ number: 1, additions: 0 })], interactions: [] });
    expect(report.metrics.churnRatePct).toBe(0);
    expect(report.metrics.conflictRatePct).toBe(0);
  });

  it("only counts churn from PRs inside the window", () => {
    // A source PR outside the window is still a valid overwrite, but its lines
    // were not "added in this window" so they must not inflate the churn rate.
    const report = buildReport({
      ...base,
      prs: [pr({ number: 5, additions: 100 })],
      interactions: [
        { sourcePr: 999, targetPr: 5, file: "a.ts", lines: 50, ageDays: 30, sourceCoder: "x", targetCoder: "claude" },
      ],
    });
    expect(report.metrics.churnedLines).toBe(0);
    expect(report.metrics.churnRatePct).toBe(0);
  });
});
