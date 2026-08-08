import { describe, expect, it } from "vitest";

import { ArgError, parseArgs, parseSince } from "./args";

const NOW = new Date("2026-08-08T12:00:00Z");

describe("parseSince", () => {
  it("reads relative windows", () => {
    expect(parseSince("24h", NOW).toISOString()).toBe("2026-08-07T12:00:00.000Z");
    expect(parseSince("7d", NOW).toISOString()).toBe("2026-08-01T12:00:00.000Z");
    expect(parseSince("2w", NOW).toISOString()).toBe("2026-07-25T12:00:00.000Z");
  });

  it("reads an absolute date", () => {
    expect(parseSince("2026-08-01", NOW).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rejects nonsense rather than silently analysing everything", () => {
    expect(() => parseSince("last tuesday", NOW)).toThrow(/could not read/);
  });
});

describe("parseArgs", () => {
  it("parses a basic run", () => {
    const args = parseArgs(["run", "--repo", "owner/name", "-n", "25"], NOW);
    expect(args.command).toBe("run");
    expect(args.repos).toEqual([{ owner: "owner", name: "name" }]);
    expect(args.count).toBe(25);
  });

  it("accepts several repos, comma-separated or repeated", () => {
    const args = parseArgs(
      ["run", "--repo", "a/b,c/d", "--repo", "e/f"],
      NOW,
    );
    expect(args.repos.map((r) => `${r.owner}/${r.name}`)).toEqual(["a/b", "c/d", "e/f"]);
  });

  it("accepts a full GitHub URL as a repo", () => {
    const args = parseArgs(["run", "--repo", "https://github.com/owner/name.git"], NOW);
    expect(args.repos[0]).toEqual({ owner: "owner", name: "name" });
  });

  it("lowercases the coder filter so --coder Claude works", () => {
    expect(parseArgs(["run", "--repo", "a/b", "--coder", "Claude,CODEX"], NOW).coders).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("defaults to the 50 most recent merges", () => {
    expect(parseArgs(["run", "--repo", "a/b"], NOW).count).toBe(50);
  });

  it("refuses --count together with --since", () => {
    // They answer the same question differently; silently preferring one would
    // produce a window the user did not ask for.
    expect(() => parseArgs(["run", "--repo", "a/b", "-n", "10", "--since", "7d"], NOW)).toThrow(
      ArgError,
    );
  });

  it("rejects a missing value instead of swallowing the next flag", () => {
    expect(() => parseArgs(["run", "--repo", "--open"], NOW)).toThrow(/needs a value/);
  });

  it("rejects an unknown option", () => {
    expect(() => parseArgs(["run", "--repo", "a/b", "--wat"], NOW)).toThrow(/unknown option/);
  });

  it("rejects a non-positive count", () => {
    expect(() => parseArgs(["run", "--repo", "a/b", "-n", "0"], NOW)).toThrow(/positive integer/);
  });

  it("carries watch tuning", () => {
    const args = parseArgs(
      ["watch", "--repo", "a/b", "--every", "25", "--interval", "15", "--once"],
      NOW,
    );
    expect(args).toMatchObject({ everyNMerges: 25, intervalMinutes: 15, once: true });
  });
});
