import { describe, expect, it } from "vitest";

import {
  diffBaseOf,
  findDirectPushes,
  findPrMerges,
  headRefFromMergeSubject,
  parseLogLines,
  selectWindow,
} from "./discover";

const LOG = [
  "aaa1|p1 p2|2026-08-08T14:59:15+08:00|Merge pull request #894 from owner/claude/thing",
  "aaa2|p3|2026-08-08T13:55:34+08:00|feat(compose): measure the derived spec (#893)",
  "aaa3|p4|2026-08-08T12:00:00+08:00|hotfix applied straight to main",
  "aaa4|p5 p6|2026-08-07T09:00:00+08:00|Merge pull request #890 from owner/codex/x",
].join("\n");

describe("parseLogLines", () => {
  it("splits sha, parents, date and subject", () => {
    const commits = parseLogLines(LOG);
    expect(commits).toHaveLength(4);
    expect(commits[0].sha).toBe("aaa1");
    expect(commits[0].parents).toEqual(["p1", "p2"]);
    expect(commits[1].parents).toEqual(["p3"]);
  });

  it("keeps a subject containing the delimiter intact", () => {
    const commits = parseLogLines("s|p|2026-01-01T00:00:00Z|fix: a|b parsing bug (#12)");
    expect(commits[0].subject).toBe("fix: a|b parsing bug (#12)");
  });
});

describe("findPrMerges", () => {
  it("recognises both merge commits and squashes", () => {
    const merges = findPrMerges(parseLogLines(LOG));
    expect(merges.map((m) => m.number)).toEqual([894, 893, 890]);
    expect(merges[0].kind).toBe("merge");
    expect(merges[1].kind).toBe("squash");
  });

  it("does not treat a single-parent 'Merge pull request' subject as a merge commit", () => {
    // A squashed merge-commit-shaped subject would otherwise be miscounted and
    // then fail conflict replay, which needs two parents.
    const merges = findPrMerges(
      parseLogLines("s|only-one|2026-01-01T00:00:00Z|Merge pull request #5 from o/b"),
    );
    expect(merges).toEqual([]);
  });

  it("ignores an issue reference that is not a trailing squash marker", () => {
    const merges = findPrMerges(
      parseLogLines("s|p|2026-01-01T00:00:00Z|fix: address #123 in the parser"),
    );
    expect(merges).toEqual([]);
  });
});

describe("findDirectPushes", () => {
  it("finds trunk commits with no PR association", () => {
    const direct = findDirectPushes(parseLogLines(LOG));
    expect(direct.map((c) => c.sha)).toEqual(["aaa3"]);
  });
});

describe("diffBaseOf", () => {
  it("uses the first parent for a merge commit", () => {
    const [merge] = findPrMerges(parseLogLines(LOG));
    expect(diffBaseOf(merge)).toBe("p1");
  });

  it("uses the single parent for a squash", () => {
    const merges = findPrMerges(parseLogLines(LOG));
    expect(diffBaseOf(merges[1])).toBe("p3");
  });
});

describe("headRefFromMergeSubject", () => {
  it("recovers the branch name, dropping the owner segment", () => {
    expect(
      headRefFromMergeSubject("Merge pull request #894 from caglarsubas/claude/devplan-arch"),
    ).toBe("claude/devplan-arch");
  });

  it("handles a branch with no slash of its own", () => {
    expect(headRefFromMergeSubject("Merge pull request #1 from owner/hotfix")).toBe("hotfix");
  });

  it("returns null for a squash subject, which carries no branch name", () => {
    // A squash-merged PR keeps its branch nowhere in git; the caller has to
    // fall back to trailers or metadata rather than guess.
    expect(headRefFromMergeSubject("feat(x): thing (#893)")).toBeNull();
  });
});

describe("selectWindow", () => {
  const merges = Array.from({ length: 200 }, (_, i) => ({
    number: 1000 - i,
    sha: `sha${i}`,
    parents: ["p"],
    mergedAt: new Date(Date.UTC(2026, 0, 1) - i * 3_600_000).toISOString(),
    kind: "squash" as const,
    subject: `change (#${1000 - i})`,
  }));

  it("takes the most recent N and a wider attribution context", () => {
    const { selected, context } = selectWindow(merges, { count: 50 });
    expect(selected).toHaveLength(50);
    expect(context.length).toBeGreaterThan(selected.length);
  });

  it("filters by date when given one", () => {
    const since = new Date(Date.UTC(2026, 0, 1) - 10 * 3_600_000);
    const { selected } = selectWindow(merges, { since });
    expect(selected.length).toBe(11);
  });

  it("still provides context when the selection is tiny", () => {
    const { selected, context } = selectWindow(merges, { count: 2 });
    expect(selected).toHaveLength(2);
    // Attribution needs history well beyond the selection or every rewritten
    // line looks unowned.
    expect(context.length).toBeGreaterThanOrEqual(52);
  });
});
