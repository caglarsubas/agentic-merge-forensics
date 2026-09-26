import { describe, expect, it } from "vitest";

import { extractFacts } from "./summary";
import type { PrSnapshot } from "./types";

const FILTER = { from: 0, to: Date.parse("2026-09-26T12:00:00Z"), windowLabel: "the last 7 days" };

function pr(repo: string, number: number, coder: string, overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    repo,
    number,
    title: "t",
    authorLogin: coder,
    headRefName: `${coder}/x`,
    coder,
    coderSource: "branch",
    state: "open",
    isDraft: false,
    createdAt: "2026-09-25T10:00:00Z",
    updatedAt: "2026-09-25T11:00:00Z",
    mergedAt: null,
    headSha: "a".repeat(40),
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    conflict: "clean",
    mergeStateStatus: "CLEAN",
    ci: "passing",
    ciFailing: 0,
    ciTotal: 3,
    url: "",
    ...overrides,
  };
}

const conflicting = { conflict: "conflicting", mergeStateStatus: "DIRTY" } as const;

describe("extractFacts PR groups", () => {
  it("words a mixed group per coder, so the model never has to count or split it", () => {
    const facts = extractFacts(
      [],
      [
        pr("o/onion", 136, "codex", conflicting),
        pr("o/labs", 18, "codex", conflicting),
        pr("o/labs", 15, "codex", conflicting),
        pr("o/labs", 14, "codex", conflicting),
        pr("o/labs", 13, "codex", conflicting),
        pr("p/tfc", 5, "refik-ergun", conflicting),
      ],
      FILTER,
    );
    expect(facts.conflictingNow.count).toBe(6);
    expect(facts.conflictingNow.description).toBe(
      "6 PRs: 5 from codex, in o/labs and o/onion; 1 from refik-ergun, in p/tfc",
    );
    expect(facts.conflictingNow.prs).toContain("p/tfc#5 by refik-ergun");
  });

  it("says 'all from' only when a single coder owns the group", () => {
    const facts = extractFacts(
      [],
      [pr("a/api", 50, "claude", conflicting), pr("a/api", 51, "claude", conflicting), pr("a/web", 7, "claude", conflicting)],
      FILTER,
    );
    expect(facts.conflictingNow.description).toBe("3 PRs, all from claude, in a/api and a/web");
  });

  it("handles a single PR and an empty group", () => {
    const facts = extractFacts([], [pr("a/api", 41, "claude", { ci: "failing", ciFailing: 1 })], FILTER);
    expect(facts.failingCiNow.description).toBe("1 PR, from claude, in a/api");
    expect(facts.conflictingNow).toEqual({ count: 0, description: "none", prs: [] });
  });

  it("labels failing checks as checks, not PRs", () => {
    const facts = extractFacts(
      [],
      [pr("a/api", 41, "claude", { ci: "failing", ciFailing: 1 }), pr("a/web", 9, "cursor", { ci: "failing", ciFailing: 3 })],
      FILTER,
    );
    expect(facts.failingCiNow.prs).toEqual([
      "a/api#41 by claude (1 check failing)",
      "a/web#9 by cursor (3 checks failing)",
    ]);
  });

  it("respects the coder and repo filters", () => {
    const facts = extractFacts(
      [],
      [pr("a/api", 1, "claude", conflicting), pr("a/web", 2, "codex", conflicting), pr("a/api", 3, "codex", conflicting)],
      { ...FILTER, coders: ["codex"], repos: ["a/api"] },
    );
    expect(facts.conflictingNow.description).toBe("1 PR, from codex, in a/api");
  });
});
