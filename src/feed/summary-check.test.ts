import { afterEach, describe, expect, it, vi } from "vitest";

import { extractFacts, writeSummary, type LlmConfig, type SummaryFacts } from "./summary";
import { checkSummary, templateSummary } from "./summary-check";
import type { FeedEvent, PrSnapshot } from "./types";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const FILTER = { from: NOW - 7 * 86_400_000, to: NOW, windowLabel: "the last 7 days" };

function pr(repo: string, number: number, coder: string, overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    repo, number, title: "t", authorLogin: coder, headRefName: `${coder}/x`, coder,
    coderSource: "branch", state: "open", isDraft: false, createdAt: "2026-09-25T10:00:00Z",
    updatedAt: "2026-09-25T11:00:00Z", mergedAt: null, headSha: "a".repeat(40), additions: 1,
    deletions: 1, changedFiles: 1, conflict: "clean", mergeStateStatus: "CLEAN", ci: "passing",
    ciFailing: 0, ciTotal: 3, url: "", ...overrides,
  };
}

function events(repo: string, spec: Array<[FeedEvent["kind"], number]>): FeedEvent[] {
  return spec.flatMap(([kind, n]) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${kind}-${i}`, kind, repo, number: i, title: "t", coder: "claude", coderSource: "branch",
      at: "2026-09-25T10:00:00Z", observedAt: "2026-09-25T10:00:00Z", state: null,
      conflict: "clean", ci: "passing", ciFailing: 0, detail: "", url: "",
    }) as FeedEvent),
  );
}

const C = { conflict: "conflicting", mergeStateStatus: "DIRTY" } as const;
const F = (n: number) => ({ ci: "failing", ciFailing: n }) as const;

/** Six conflicts: codex has four in o/labs and one in o/onion, refik-ergun one in p/tfc. */
const REAL = extractFacts(
  [...events("o/labs", [["pr-merged", 5]]), ...events("o/web", [["push", 3]])],
  [
    pr("o/onion", 136, "codex", C), pr("o/labs", 18, "codex", C), pr("o/labs", 15, "codex", C),
    pr("o/labs", 14, "codex", C), pr("o/labs", 13, "codex", C), pr("p/tfc", 5, "refik-ergun", C),
    pr("o/lab", 124, "dependabot", F(1)),
  ],
  FILTER,
);

/** Claude has one conflict and two failing PRs; codex one conflict; cursor one failing. */
const MIXED = extractFacts(
  events("a/api", [["pr-merged", 4], ["pr-opened", 3]]),
  [pr("a/api", 41, "claude", F(2)), pr("a/api", 44, "claude", { ...F(1), ...C }), pr("a/web", 9, "cursor", F(3)), pr("a/web", 12, "codex", C)],
  FILTER,
);

/** Claude has three conflicts: two in a/api, one in a/web. */
const SINGLE = extractFacts(
  events("a/api", [["pr-merged", 6]]),
  [pr("a/api", 50, "claude", C), pr("a/api", 51, "claude", C), pr("a/web", 7, "claude", C)],
  FILTER,
);

/** Nothing needs attention; everything happened in one repo. */
const QUIET = extractFacts(
  events("o/app", [["pr-merged", 10], ["pr-opened", 6], ["push", 2]]),
  [pr("o/app", 60, "claude"), pr("o/app", 61, "codex")],
  FILTER,
);

const WRONG: Array<[SummaryFacts, string]> = [
  [REAL, "Five PRs from codex in o/labs and one in o/onion are stuck in conflict."],
  [REAL, "Six PRs conflict now: five from codex in o/labs and one from refik-ergun in p/tfc."],
  [REAL, "Six PRs are in conflict, all from codex."],
  [REAL, "The codex agent has 6 conflicting PRs in o/labs (5) and o/onion (1)."],
  [REAL, "Five of codex's PRs are in conflict, all in o/labs."],
  [REAL, "The codex agent has opened six conflicting PRs in the o/labs and o/onion repos."],
  [REAL, "Six codex PRs in o/labs are conflicting."],
  [REAL, "Codex has five conflicting PRs across two repos: three in o/labs and two in o/onion."],
  [REAL, "Six PRs conflict. caglar and claude drove most activity (82 and 75 events)."],
  [MIXED, "Claude has two PRs that now conflict, one in a/api and one in a/web."],
  [MIXED, "Claude's PR in a/api (#44) and a/web (#12) both conflict with their base branches."],
  [MIXED, "Three CI failures: two in claude's a/api PRs and three in cursor's a/web PR."],
  [MIXED, "Two PRs conflict. No direct pushes or merges happened in the last seven days."],
  [SINGLE, "Claude has three PRs stuck in conflict, one each in a/api (#50, #51) and a/web (#7)."],
  [SINGLE, "Claude has three conflicting PRs: all three in a/api and one in a/web."],
  [QUIET, "No conflicts or failing checks. Claude merged 12 PRs in o/app."],
  [QUIET, "No conflicts. Two PRs remain open in o/app: one was merged, six were opened and two were direct-pushed."],
  [MIXED, "Claude's PR in a/api conflicts with its base branch. The a/web#12 PR from codex also fails CI."],
  [REAL, "One CI check is failing in o/lab (PR #999)."],
  [QUIET, "No conflicts. Two PRs remain open in o/app, one from agent-001 and one from agent-002."],
];

const RIGHT: Array<[SummaryFacts, string]> = [
  [REAL, "Six PRs conflict: five from codex in o/labs and o/onion, and one from refik-ergun in p/tfc. One CI check is failing in o/lab from dependabot (PR #124)."],
  [REAL, "Five PRs from codex (four in o/labs, one in o/onion) and one from refik-ergun (p/tfc) are in conflict. No other urgent issues."],
  [REAL, "The six conflicting PRs, five from codex and one from refik-ergun, need review across three repos."],
  [MIXED, "Two PRs are stuck: one from claude in a/api and one from codex in a/web. Three PRs are failing CI: two from claude in a/api and one from cursor in a/web (3 checks failing)."],
  [MIXED, "Claude's a/api#41 and a/api#44 (2 and 1 checks) and cursor's a/web#9 (3 checks) are failing CI, six checks in total."],
  [SINGLE, "Claude has three PRs stuck in conflict, two in a/api and one in a/web. No CI failures. 6 PRs merged in the last 7 days."],
  [SINGLE, "Three PRs conflict, all from claude, in a/api and a/web."],
  [QUIET, "No conflicts or failing checks. Two PRs remain open in o/app, and the last 7 days saw 10 merged, 6 opened and 2 direct pushes."],
  [QUIET, "Nothing needs attention: activity was entirely in o/app, with no other conflicts to review."],
];

describe("checkSummary rejects numbers attached to the wrong thing", () => {
  it.each(WRONG.map(([facts, text]) => [text, facts] as const))("%s", (text, facts) => {
    expect(checkSummary(text, facts)).not.toEqual([]);
  });
});

describe("checkSummary lets correct summaries through", () => {
  it.each(RIGHT.map(([facts, text]) => [text, facts] as const))("%s", (text, facts) => {
    expect(checkSummary(text, facts)).toEqual([]);
  });

  it.each([["real", REAL], ["mixed", MIXED], ["single", SINGLE], ["quiet", QUIET]])(
    "the %s template passes its own check",
    (_, facts) => {
      expect(checkSummary(templateSummary(facts), facts)).toEqual([]);
    },
  );
});

describe("writeSummary", () => {
  const config: LlmConfig = { baseUrl: "http://llm", model: "m", apiKey: null, flavour: "ollama", timeoutMs: 60_000 };
  const reply = (content: string) => new Response(JSON.stringify({ message: { content } }));

  afterEach(() => vi.unstubAllGlobals());

  it("sends the problems back and keeps a corrected draft", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply("Six PRs are in conflict, all from codex."))
      .mockResolvedValueOnce(reply("Six PRs conflict: five from codex and one from refik-ergun."));
    vi.stubGlobal("fetch", fetch);

    const written = await writeSummary(REAL, config);
    expect(written).toMatchObject({ source: "model", attempts: 2 });
    expect(written.text).toContain("refik-ergun");
    const retry = JSON.parse(fetch.mock.calls[1][1].body as string);
    expect(retry.messages.at(-2)).toEqual({ role: "assistant", content: "Six PRs are in conflict, all from codex." });
    expect(retry.messages.at(-1).content).toContain('"all from codex" is not true');
  });

  it("falls back to the facts when every draft is wrong", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => reply("Codex has 6 conflicting PRs.")));
    const written = await writeSummary(REAL, config);
    expect(written).toMatchObject({ source: "template", attempts: 3, text: templateSummary(REAL) });
    expect(written.rejected).toHaveLength(3);
  });

  it("propagates a first-call failure but falls back on a failed correction", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    await expect(writeSummary(REAL, config)).rejects.toThrow("ECONNREFUSED");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(reply("Codex has 6 conflicting PRs.")).mockRejectedValueOnce(new Error("timeout")),
    );
    expect(await writeSummary(REAL, config)).toMatchObject({ source: "template", attempts: 1 });
  });
});
