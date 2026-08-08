import { describe, expect, it } from "vitest";

import { DEFAULT_CODER_RULES, detectCoder, knownCoders } from "./coder";

describe("detectCoder", () => {
  it("prefers the branch prefix, the signal the harness controls", () => {
    expect(detectCoder({ headRefName: "claude/devplan-c2", authorLogin: "someone" })).toBe(
      "claude",
    );
    expect(detectCoder({ headRefName: "codex/workflow-sim", authorLogin: "someone" })).toBe(
      "codex",
    );
  });

  it("is case-insensitive about the prefix", () => {
    expect(detectCoder({ headRefName: "Claude/Thing" })).toBe("claude");
  });

  it("falls back to commit trailers when the branch is unprefixed", () => {
    expect(
      detectCoder({
        headRefName: "feature-work",
        commitMessages: ["feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"],
      }),
    ).toBe("claude");
  });

  it("ignores an agent named in prose rather than a trailer", () => {
    // Otherwise "this fixes what Claude broke" would reassign the PR.
    expect(
      detectCoder({
        headRefName: "feature-work",
        authorLogin: "alice",
        commitMessages: ["fix: undo the change Claude made yesterday"],
      }),
    ).toBe("alice");
  });

  it("recognises bot authors", () => {
    expect(
      detectCoder({ headRefName: "dependabot/npm_and_yarn/x", authorLogin: "app/dependabot" }),
    ).toBe("dependabot");
    expect(detectCoder({ headRefName: "", authorLogin: "app/dependabot" })).toBe("dependabot");
  });

  it("falls back to the author login so humans group by person", () => {
    expect(detectCoder({ headRefName: "my-feature", authorLogin: "caglarsubas" })).toBe(
      "caglarsubas",
    );
  });

  it("returns unknown rather than guessing when there is no signal", () => {
    expect(detectCoder({})).toBe("unknown");
  });

  it("accepts custom rules without touching the defaults", () => {
    const coder = detectCoder(
      { headRefName: "aider/refactor" },
      [{ coder: "aider", branchPrefixes: ["aider"] }],
    );
    expect(coder).toBe("aider");
    expect(knownCoders()).toEqual(DEFAULT_CODER_RULES.map((r) => r.coder));
  });
});
