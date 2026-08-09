import { describe, expect, it } from "vitest";

import {
  BACKOFF_CEILING_MS,
  DEFAULT_CAP,
  backoffFor,
  planCycle,
  type PlanInput,
} from "./plan";
import type { PrSnapshot, RepoWatermark, WatchEntry } from "./types";

const T0 = new Date("2026-08-09T12:00:00Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

function iso(offsetMs: number): string {
  return at(offsetMs).toISOString();
}

function watch(slug: string, paused = false): WatchEntry {
  return { slug, addedAt: "2026-07-01T00:00:00Z", paused };
}

function mark(slug: string, overrides: Partial<RepoWatermark> = {}): RepoWatermark {
  return {
    slug,
    pushedAt: iso(-2 * 60 * MINUTE),
    lastCommitSha: "abc123",
    lastPolledAt: iso(-30 * MINUTE),
    defaultBranch: "main",
    failures: 0,
    nextEligibleAt: null,
    lastError: null,
    ...overrides,
  };
}

function openPr(repo: string, overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    repo,
    number: 7,
    title: "do the thing",
    authorLogin: "someone",
    headRefName: "claude/do-the-thing",
    coder: "claude",
    coderSource: "branch",
    state: "open",
    isDraft: false,
    createdAt: iso(-3 * 60 * MINUTE),
    updatedAt: iso(-10 * MINUTE),
    mergedAt: null,
    headSha: "deadbee",
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    conflict: "clean",
    mergeStateStatus: "CLEAN",
    ci: "passing",
    ciFailing: 0,
    ciTotal: 3,
    url: `https://github.com/${repo}/pull/7`,
    ...overrides,
  };
}

/** A roster with watermarks and a listing that says nothing moved. */
function quietRoster(count: number): {
  watchlist: WatchEntry[];
  watermarks: Record<string, RepoWatermark>;
  pushedAt: Record<string, string | null>;
} {
  const watchlist: WatchEntry[] = [];
  const watermarks: Record<string, RepoWatermark> = {};
  const pushedAt: Record<string, string | null> = {};
  for (let i = 0; i < count; i++) {
    const slug = `acme/repo-${String(i).padStart(3, "0")}`;
    watchlist.push(watch(slug));
    watermarks[slug] = mark(slug);
    pushedAt[slug] = watermarks[slug].pushedAt;
  }
  return { watchlist, watermarks, pushedAt };
}

function plan(input: Partial<PlanInput>, now: Date = T0) {
  return planCycle(
    {
      watchlist: [],
      watermarks: {},
      pushedAt: {},
      cycle: 0,
      ...input,
    },
    now,
  );
}

function slugsOf(polled: Array<{ slug: string }>): string[] {
  return polled.map((entry) => entry.slug);
}

describe("planCycle", () => {
  it("treats every repo as cold when the watermark map is empty", () => {
    // First run after install: nothing has ever been polled, so nothing can be
    // ruled quiet. A never-polled repo is infinitely stale and sorts first.
    const watchlist = ["a/one", "b/two", "c/three"].map((slug) => watch(slug));
    const result = plan({ watchlist, pushedAt: { "a/one": iso(-MINUTE) } });

    expect(slugsOf(result.poll)).toEqual(["a/one", "b/two", "c/three"]);
    expect(result.poll.every((entry) => entry.reason === "cold")).toBe(true);
    expect(result.poll[0].staleMs).toBe(Number.POSITIVE_INFINITY);
    expect(result.deferred).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("truncates to the cap and reports the rest as deferred", () => {
    const { watchlist, watermarks } = quietRoster(30);
    const pushedAt: Record<string, string | null> = {};
    for (const entry of watchlist) pushedAt[entry.slug] = iso(-MINUTE);

    const result = plan({ watchlist, watermarks, pushedAt, cap: DEFAULT_CAP });

    expect(result.poll).toHaveLength(12);
    expect(result.deferred).toHaveLength(18);
    // The two sets must partition the eligible repos: a repo counted as polled
    // and deferred at once would make the coverage claim meaningless.
    const overlap = slugsOf(result.poll).filter((slug) => result.deferred.includes(slug));
    expect(overlap).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("orders by staleness, longest unpolled first", () => {
    const watchlist = ["a/fresh", "b/stale", "c/middle"].map((slug) => watch(slug));
    const watermarks = {
      "a/fresh": mark("a/fresh", { lastPolledAt: iso(-2 * MINUTE) }),
      "b/stale": mark("b/stale", { lastPolledAt: iso(-90 * MINUTE) }),
      "c/middle": mark("c/middle", { lastPolledAt: iso(-20 * MINUTE) }),
    };
    const pushedAt = {
      "a/fresh": iso(-MINUTE),
      "b/stale": iso(-MINUTE),
      "c/middle": iso(-MINUTE),
    };

    const result = plan({ watchlist, watermarks, pushedAt });
    expect(slugsOf(result.poll)).toEqual(["b/stale", "c/middle", "a/fresh"]);
  });

  it("never polls a paused entry, however loud it is", () => {
    const watchlist = [watch("a/live"), watch("b/paused", true)];
    const result = plan({
      watchlist,
      // No watermark for either: both would be cold, the strongest reason there
      // is. Paused still wins.
      pushedAt: { "a/live": iso(-MINUTE), "b/paused": iso(-SECOND) },
      openPrs: [openPr("b/paused", { ci: "pending" })],
    });

    expect(slugsOf(result.poll)).toEqual(["a/live"]);
    expect(result.skipped).toEqual([{ slug: "b/paused", reason: "paused" }]);
    // And it must not eat a sweep slot either.
    expect(result.sweep).not.toContain("b/paused");
  });

  it("holds a repo inside its backoff window and releases it after", () => {
    const watchlist = [watch("a/flaky")];
    const watermarks = {
      "a/flaky": mark("a/flaky", {
        failures: 3,
        nextEligibleAt: iso(5 * MINUTE),
        lastError: "gh api 403",
        lastPolledAt: iso(-10 * MINUTE),
      }),
    };
    // A real push is waiting. It does not buy a way past the gate: a repo that
    // is erroring is erroring, and new commits do not make the API answer.
    const pushedAt = { "a/flaky": iso(-MINUTE) };

    const held = plan({ watchlist, watermarks, pushedAt }, at(MINUTE));
    expect(held.poll).toEqual([]);
    expect(held.skipped).toEqual([
      { slug: "a/flaky", reason: "backoff", until: iso(5 * MINUTE) },
    ]);

    const released = plan({ watchlist, watermarks, pushedAt }, at(6 * MINUTE));
    expect(slugsOf(released.poll)).toEqual(["a/flaky"]);
    expect(released.poll[0].reason).toBe("pushed");
  });

  it("retries a due failure even though nothing changed", () => {
    // The poll that failed never advanced the watermark, so no other signal
    // will ever mark this repo interesting. Without the retry reason it would
    // wait for its next sweep slot to find out the outage ended.
    const watchlist = [watch("a/flaky")];
    const watermarks = {
      "a/flaky": mark("a/flaky", { failures: 2, nextEligibleAt: iso(-MINUTE) }),
    };
    const pushedAt = { "a/flaky": watermarks["a/flaky"].pushedAt };

    const result = plan({ watchlist, watermarks, pushedAt, sweepSlice: 0 });
    expect(result.poll).toHaveLength(1);
    expect(result.poll[0].reason).toBe("retry");
  });

  it("suppresses a repo that pushed twice in quick succession, then lets it through", () => {
    const watchlist = [watch("a/busy")];
    const watermarks = {
      "a/busy": mark("a/busy", { pushedAt: iso(-70 * SECOND), lastPolledAt: iso(-60 * SECOND) }),
    };
    // Second push landed ten seconds after the poll that saw the first.
    const pushedAt = { "a/busy": iso(-50 * SECOND) };

    const tooSoon = plan(
      { watchlist, watermarks, pushedAt, minRepollMs: 90 * SECOND, sweepSlice: 0 },
      T0,
    );
    expect(tooSoon.poll).toEqual([]);
    expect(tooSoon.skipped).toEqual([{ slug: "a/busy", reason: "cooldown" }]);

    const later = plan(
      { watchlist, watermarks, pushedAt, minRepollMs: 90 * SECOND, sweepSlice: 0 },
      at(45 * SECOND),
    );
    expect(slugsOf(later.poll)).toEqual(["a/busy"]);
    expect(later.poll[0].reason).toBe("pushed");
  });

  it("does not let the cooldown gate a repo that has never been polled", () => {
    const result = plan({
      watchlist: [watch("a/new")],
      minRepollMs: 10 * MINUTE,
    });
    expect(slugsOf(result.poll)).toEqual(["a/new"]);
  });

  it("polls a repo whose CI was still pending at the last look", () => {
    // Nothing pushes when a check finishes, so pushed_at alone would report the
    // failure whenever the next commit happened to land.
    const { watchlist, watermarks, pushedAt } = quietRoster(4);
    const target = watchlist[2].slug;

    const result = plan({
      watchlist,
      watermarks,
      pushedAt,
      sweepSlice: 0,
      openPrs: [openPr(target, { ci: "pending" })],
    });

    expect(slugsOf(result.poll)).toEqual([target]);
    expect(result.poll[0].reason).toBe("unsettled");
  });

  it("polls a repo whose mergeability GitHub had not computed yet", () => {
    const { watchlist, watermarks, pushedAt } = quietRoster(3);
    const target = watchlist[0].slug;

    const result = plan({
      watchlist,
      watermarks,
      pushedAt,
      sweepSlice: 0,
      openPrs: [openPr(target, { conflict: "unknown", mergeStateStatus: "UNKNOWN" })],
    });

    expect(slugsOf(result.poll)).toEqual([target]);
  });

  it("leaves settled open PRs alone", () => {
    const { watchlist, watermarks, pushedAt } = quietRoster(3);
    const result = plan({
      watchlist,
      watermarks,
      pushedAt,
      sweepSlice: 0,
      openPrs: [
        openPr(watchlist[0].slug, { ci: "failing", ciFailing: 2 }),
        openPr(watchlist[1].slug, { conflict: "conflicting", mergeStateStatus: "DIRTY" }),
        // A merged snapshot lingering in the index is not a reason to poll.
        openPr(watchlist[2].slug, { state: "merged", ci: "pending" }),
      ],
    });

    expect(result.poll).toEqual([]);
    expect(result.skipped.every((entry) => entry.reason === "quiet")).toBe(true);
  });

  it("does not read a repo missing from the listing as quiet", () => {
    // /user/repos only covers affiliated repos, so an absent slug means "no
    // information", not "no pushes". Only the sweep can see these at all.
    const watchlist = [watch("a/unlisted")];
    const watermarks = { "a/unlisted": mark("a/unlisted") };

    const noSweep = plan({ watchlist, watermarks, pushedAt: {}, sweepSlice: 0 });
    expect(noSweep.poll).toEqual([]);
    expect(noSweep.skipped).toEqual([{ slug: "a/unlisted", reason: "quiet" }]);

    const withSweep = plan({ watchlist, watermarks, pushedAt: {} });
    expect(slugsOf(withSweep.poll)).toEqual(["a/unlisted"]);
    expect(withSweep.poll[0].reason).toBe("sweep");
  });

  it("sweeps every repo within the number of cycles it promises", () => {
    // The property the sweep exists for. 37 repos at a quarter each is a slice
    // of 10 and four cycles to cover the roster; the loop is the assertion.
    const { watchlist, watermarks, pushedAt } = quietRoster(37);
    const interval = 3 * MINUTE;
    const seen = new Set<string>();
    let promised = 0;

    for (let cycle = 0; cycle < 4; cycle++) {
      const now = at(cycle * interval);
      const result = planCycle({ watchlist, watermarks, pushedAt, cycle }, now);
      promised = result.sweepCycles;
      for (const entry of result.poll) {
        expect(entry.reason).toBe("sweep");
        seen.add(entry.slug);
        // Simulate the poller writing back what it learned.
        watermarks[entry.slug] = { ...watermarks[entry.slug], lastPolledAt: now.toISOString() };
      }
    }

    expect(promised).toBe(4);
    expect(seen.size).toBe(37);
  });

  it("still sweeps the whole roster at 161 repos, and stays inside the cap", () => {
    const { watchlist, watermarks, pushedAt } = quietRoster(161);
    const interval = 3 * MINUTE;
    const seen = new Set<string>();

    const first = planCycle({ watchlist, watermarks, pushedAt, cycle: 0 }, T0);
    // A quarter of 161 is 41 polls, which the cap could never honour, so the
    // slice narrows to the cap and the promise lengthens instead of lying.
    expect(first.sweep).toHaveLength(DEFAULT_CAP);
    expect(first.sweepCycles).toBe(Math.ceil(161 / DEFAULT_CAP));

    for (let cycle = 0; cycle < first.sweepCycles; cycle++) {
      const now = at(cycle * interval);
      const result = planCycle({ watchlist, watermarks, pushedAt, cycle }, now);
      expect(result.poll.length).toBeLessThanOrEqual(DEFAULT_CAP);
      for (const entry of result.poll) {
        seen.add(entry.slug);
        watermarks[entry.slug] = { ...watermarks[entry.slug], lastPolledAt: now.toISOString() };
      }
    }

    expect(seen.size).toBe(161);
  });

  it("derives the same slice whatever order the watchlist is in", () => {
    // The rotation is a promise about coverage, so it cannot depend on how the
    // user happened to add repos, nor on anything that moves between cycles.
    const { watchlist, watermarks, pushedAt } = quietRoster(20);
    const shuffled = [...watchlist].reverse();

    const a = planCycle({ watchlist, watermarks, pushedAt, cycle: 3 }, T0);
    const b = planCycle({ watchlist: shuffled, watermarks, pushedAt, cycle: 3 }, T0);

    expect(b.sweep).toEqual(a.sweep);
    expect(slugsOf(b.poll)).toEqual(slugsOf(a.poll));
  });

  it("lets a real change outrank a stale sweep slot when the cap is tight", () => {
    // At a large roster the sweep alone fills a cycle. If staleness decided
    // outright, a push would wait a full rotation to be noticed.
    const { watchlist, watermarks, pushedAt } = quietRoster(20);
    const pushedRepo = watchlist[19].slug;
    watermarks[pushedRepo] = mark(pushedRepo, { lastPolledAt: iso(-2 * MINUTE) });
    pushedAt[pushedRepo] = iso(-MINUTE);

    const result = planCycle({ watchlist, watermarks, pushedAt, cycle: 0, cap: 2 }, T0);

    expect(result.poll[0]).toMatchObject({ slug: pushedRepo, reason: "pushed" });
    expect(result.poll).toHaveLength(2);
    expect(result.poll[1].reason).toBe("sweep");
    expect(result.deferred.length).toBeGreaterThan(0);
  });

  it("polls nothing but still reports what it would have, at a cap of zero", () => {
    const { watchlist, watermarks, pushedAt } = quietRoster(5);
    for (const entry of watchlist) pushedAt[entry.slug] = iso(-MINUTE);

    const result = planCycle({ watchlist, watermarks, pushedAt, cycle: 0, cap: 0 }, T0);

    expect(result.poll).toEqual([]);
    expect(result.deferred).toHaveLength(5);
  });

  it("ignores a duplicated slug rather than polling it twice", () => {
    const result = plan({ watchlist: [watch("a/one"), watch("a/one")] });
    expect(slugsOf(result.poll)).toEqual(["a/one"]);
  });

  it("treats an unparseable stored timestamp as never polled", () => {
    // A hand-edited state file should degrade to an extra poll, not to a repo
    // that is silently never eligible again.
    const watchlist = [watch("a/one")];
    const watermarks = {
      "a/one": mark("a/one", { lastPolledAt: "not a date", nextEligibleAt: "also not a date" }),
    };
    // Sweep off, so the reason proves the watermark was read as unusable
    // rather than the rotation happening to cover for it.
    const result = plan({
      watchlist,
      watermarks,
      pushedAt: {},
      minRepollMs: 10 * MINUTE,
      sweepSlice: 0,
    });

    expect(slugsOf(result.poll)).toEqual(["a/one"]);
    expect(result.poll[0].reason).toBe("cold");
  });

  it("survives an empty watchlist", () => {
    const result = plan({});
    expect(result).toMatchObject({ poll: [], deferred: [], skipped: [], sweep: [], sweepCycles: 0 });
  });
});

describe("backoffFor", () => {
  it("does not wait at all when nothing has failed", () => {
    expect(backoffFor(0, 60_000)).toBe(0);
    expect(backoffFor(-1, 60_000)).toBe(0);
  });

  it("doubles from the base", () => {
    expect(backoffFor(1, 1_000)).toBe(1_000);
    expect(backoffFor(2, 1_000)).toBe(2_000);
    expect(backoffFor(3, 1_000)).toBe(4_000);
  });

  it("stops at the ceiling instead of growing forever", () => {
    // A repo whose auth expired should come back minutes after it is fixed,
    // not hours. 2 ** 1000 would also overflow to Infinity, which would make
    // nextEligibleAt an invalid date.
    expect(backoffFor(40, 60_000)).toBe(BACKOFF_CEILING_MS);
    expect(backoffFor(1_000, 60_000)).toBe(BACKOFF_CEILING_MS);
    expect(Number.isFinite(backoffFor(1_000, 60_000))).toBe(true);
  });

  it("never goes backwards as failures accumulate", () => {
    let previous = -1;
    for (let failures = 0; failures <= 20; failures++) {
      const wait = backoffFor(failures, 30_000);
      expect(wait).toBeGreaterThanOrEqual(previous);
      previous = wait;
    }
  });
});
