import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FeedEvent, RepoWatermark } from "../feed/types";
import {
  FEED_INDEX_LIMIT,
  addWatch,
  appendEvents,
  readCycleStatus,
  readFeedIndex,
  readRecentEvents,
  readRepoWatermarks,
  readWatchlist,
  removeWatch,
  setWatchPaused,
  writeCycleStatus,
  writeFeedIndex,
  writeRepoWatermark,
} from "./feed-store";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mf-feed-store-"));
  process.env.MERGE_FORENSICS_HOME = home;
});

afterEach(() => {
  delete process.env.MERGE_FORENSICS_HOME;
  rmSync(home, { recursive: true, force: true });
});

function feedDir(): string {
  return join(home, "state", "feed");
}

/** Drop a hand-written file into the feed directory, index included. */
function seed(name: string, contents: string): void {
  mkdirSync(feedDir(), { recursive: true });
  writeFileSync(join(feedDir(), name), contents, "utf8");
}

function makeEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    id: "owner/repo#1:pr-opened",
    kind: "pr-opened",
    repo: "owner/repo",
    number: 1,
    title: "feat: thing",
    coder: "claude",
    coderSource: "branch",
    at: "2026-08-01T10:00:00Z",
    observedAt: "2026-08-01T10:04:00Z",
    state: "open",
    conflict: "unknown",
    ci: "pending",
    ciFailing: 0,
    detail: "+10 −1",
    url: "https://github.com/owner/repo/pull/1",
    ...overrides,
  };
}

function makeWatermark(overrides: Partial<RepoWatermark> = {}): RepoWatermark {
  return {
    slug: "owner/repo",
    pushedAt: "2026-08-01T10:00:00Z",
    lastCommitSha: "abc123",
    lastPolledAt: "2026-08-01T10:05:00Z",
    defaultBranch: "main",
    failures: 0,
    nextEligibleAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("watchlist", () => {
  const now = new Date("2026-08-01T09:00:00Z");

  it("round-trips through disk", () => {
    addWatch("owner/repo", now);
    expect(readWatchlist()).toEqual([{ slug: "owner/repo", addedAt: "2026-08-01T09:00:00.000Z" }]);
  });

  it("reads as empty before anything is watched", () => {
    expect(readWatchlist()).toEqual([]);
  });

  it("does not duplicate a repo that is already watched", () => {
    addWatch("owner/repo", now);
    const second = addWatch("owner/repo", new Date("2026-08-02T09:00:00Z"));
    expect(second).toHaveLength(1);
    // The original addedAt survives; re-adding is not a way to reset it.
    expect(second[0].addedAt).toBe("2026-08-01T09:00:00.000Z");
  });

  it("treats a differently-cased slug as the same repo", () => {
    addWatch("owner/repo", now);
    expect(addWatch("Owner/Repo", now)).toHaveLength(1);
  });

  it("removes a repo and leaves the others alone", () => {
    addWatch("a/one", now);
    addWatch("a/two", now);
    expect(removeWatch("a/one").map((entry) => entry.slug)).toEqual(["a/two"]);
  });

  it("treats removing an unwatched repo as a no-op rather than an error", () => {
    addWatch("a/one", now);
    expect(() => removeWatch("nobody/here")).not.toThrow();
    expect(removeWatch("nobody/here").map((entry) => entry.slug)).toEqual(["a/one"]);
  });

  it("pauses and unpauses in place", () => {
    addWatch("a/one", now);
    expect(setWatchPaused("a/one", true)[0].paused).toBe(true);
    expect(readWatchlist()[0].paused).toBe(true);
    expect(setWatchPaused("a/one", false)[0].paused).toBe(false);
    expect(readWatchlist()[0].paused).toBe(false);
  });

  it("does not invent an entry when pausing an unwatched repo", () => {
    expect(setWatchPaused("nobody/here", true)).toEqual([]);
    expect(readWatchlist()).toEqual([]);
  });

  it("falls back to empty rather than throwing on a truncated file", () => {
    seed("watchlist.json", '[{"slug":"owner/re');
    expect(readWatchlist()).toEqual([]);
    // And the next write repairs it.
    expect(addWatch("owner/repo", now)).toHaveLength(1);
  });
});

describe("repo watermarks", () => {
  it("round-trips through disk", () => {
    writeRepoWatermark(makeWatermark({ failures: 2, lastError: "rate limited" }));
    const all = readRepoWatermarks();
    expect(all["owner/repo"].failures).toBe(2);
    expect(all["owner/repo"].lastError).toBe("rate limited");
  });

  it("merges rather than replacing the whole map", () => {
    writeRepoWatermark(makeWatermark({ slug: "a/one" }));
    writeRepoWatermark(makeWatermark({ slug: "a/two" }));
    expect(Object.keys(readRepoWatermarks()).sort()).toEqual(["a/one", "a/two"]);
  });

  it("reads as empty before the first poll", () => {
    expect(readRepoWatermarks()).toEqual({});
  });
});

describe("appendEvents", () => {
  it("splits a batch that straddles a month boundary into two shards", () => {
    appendEvents([
      makeEvent({ id: "july", at: "2026-07-31T23:50:00Z" }),
      makeEvent({ id: "august", at: "2026-08-01T00:10:00Z" }),
    ]);
    expect(readdirSync(feedDir()).sort()).toEqual([
      "events-2026-07.ndjson",
      "events-2026-08.ndjson",
    ]);
    expect(readRecentEvents(10).map((event) => event.id)).toEqual(["august", "july"]);
  });

  it("appends rather than rewriting the shard", () => {
    appendEvents([makeEvent({ id: "first", at: "2026-08-01T10:00:00Z" })]);
    appendEvents([makeEvent({ id: "second", at: "2026-08-02T10:00:00Z" })]);
    expect(readdirSync(feedDir())).toEqual(["events-2026-08.ndjson"]);
    expect(readRecentEvents(10).map((event) => event.id)).toEqual(["second", "first"]);
  });

  it("writes nothing at all for an empty batch", () => {
    appendEvents([]);
    expect(readRecentEvents(10)).toEqual([]);
  });

  it("parks an event with an unusable timestamp in a shard that sorts last", () => {
    appendEvents([
      makeEvent({ id: "junk", at: "", observedAt: "" }),
      makeEvent({ id: "real", at: "2026-08-01T10:00:00Z" }),
    ]);
    expect(readdirSync(feedDir()).sort()).toEqual([
      "events-0000-00.ndjson",
      "events-2026-08.ndjson",
    ]);
    expect(readRecentEvents(10).map((event) => event.id)).toEqual(["real", "junk"]);
  });
});

describe("readRecentEvents", () => {
  it("returns nothing before the first poll", () => {
    expect(readRecentEvents(10)).toEqual([]);
  });

  it("returns the newest events first, honouring the limit", () => {
    appendEvents([
      makeEvent({ id: "a", at: "2026-08-01T10:00:00Z" }),
      makeEvent({ id: "b", at: "2026-08-03T10:00:00Z" }),
      makeEvent({ id: "c", at: "2026-08-02T10:00:00Z" }),
    ]);
    expect(readRecentEvents(2).map((event) => event.id)).toEqual(["b", "c"]);
  });

  it("crosses into older shards only when the newer ones do not fill the limit", () => {
    appendEvents([makeEvent({ id: "june", at: "2026-06-01T10:00:00Z" })]);
    appendEvents([makeEvent({ id: "july", at: "2026-07-01T10:00:00Z" })]);
    appendEvents([makeEvent({ id: "august", at: "2026-08-01T10:00:00Z" })]);
    expect(readRecentEvents(1).map((event) => event.id)).toEqual(["august"]);
    expect(readRecentEvents(2).map((event) => event.id)).toEqual(["august", "july"]);
    expect(readRecentEvents(99).map((event) => event.id)).toEqual(["august", "july", "june"]);
  });

  it("orders events sharing a timestamp deterministically", () => {
    appendEvents([
      makeEvent({ id: "zzz", at: "2026-08-01T10:00:00Z" }),
      makeEvent({ id: "aaa", at: "2026-08-01T10:00:00Z" }),
    ]);
    expect(readRecentEvents(10).map((event) => event.id)).toEqual(["aaa", "zzz"]);
  });

  it("returns nothing for a non-positive limit", () => {
    appendEvents([makeEvent()]);
    expect(readRecentEvents(0)).toEqual([]);
    expect(readRecentEvents(-1)).toEqual([]);
  });

  it("skips a half-written last line instead of throwing", () => {
    const good = JSON.stringify(makeEvent({ id: "good" }));
    seed("events-2026-08.ndjson", `${good}\n{"id":"torn","kind":"pr-`);
    expect(readRecentEvents(10).map((event) => event.id)).toEqual(["good"]);
  });

  it("ignores files in the feed directory that are not shards", () => {
    appendEvents([makeEvent({ id: "real" })]);
    seed("watchlist.json", "[]");
    seed("events-2026-08.ndjson.tmp", "garbage");
    expect(readRecentEvents(10).map((event) => event.id)).toEqual(["real"]);
  });
});

describe("feed index", () => {
  it("is null before the first cycle writes one", () => {
    expect(readFeedIndex()).toBeNull();
  });

  it("round-trips events and open PRs", () => {
    writeFeedIndex({
      events: [makeEvent({ id: "e1" })],
      prs: [],
      updatedAt: "2026-08-01T10:05:00Z",
    });
    const index = readFeedIndex();
    expect(index?.events.map((event) => event.id)).toEqual(["e1"]);
    expect(index?.updatedAt).toBe("2026-08-01T10:05:00Z");
  });

  it("caps the snapshot, keeping the front of the caller's order", () => {
    const events = Array.from({ length: FEED_INDEX_LIMIT + 100 }, (_, i) =>
      makeEvent({ id: `e${i}` }),
    );
    writeFeedIndex({ events, prs: [], updatedAt: "2026-08-01T10:05:00Z" });
    const stored = readFeedIndex()?.events ?? [];
    expect(stored).toHaveLength(FEED_INDEX_LIMIT);
    expect(stored[0].id).toBe("e0");
    expect(stored[FEED_INDEX_LIMIT - 1].id).toBe(`e${FEED_INDEX_LIMIT - 1}`);
  });

  it("falls back to null rather than throwing on a corrupt file", () => {
    seed("index.json", "{ not json");
    expect(readFeedIndex()).toBeNull();
  });
});

describe("cycle status", () => {
  it("is null before the first cycle", () => {
    expect(readCycleStatus()).toBeNull();
  });

  it("round-trips through disk", () => {
    writeCycleStatus({
      cycle: 1,
      startedAt: "2026-08-01T10:00:00Z",
      finishedAt: "2026-08-01T10:00:12Z",
      durationMs: 12000,
      polled: ["owner/repo"],
      skipped: 3,
      deferred: 1,
      newEvents: 2,
      errors: [{ slug: "a/one", message: "gh exited 1" }],
      throttled: true,
      rateRemaining: 4900,
    });
    const status = readCycleStatus();
    expect(status?.polled).toEqual(["owner/repo"]);
    expect(status?.errors[0].message).toBe("gh exited 1");
    expect(status?.throttled).toBe(true);
  });

  it("falls back to null rather than throwing on a corrupt file", () => {
    seed("status.json", "");
    expect(readCycleStatus()).toBeNull();
  });
});
