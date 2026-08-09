import { describe, expect, it } from "vitest";

import {
  dedupe,
  diffPrs,
  eventId,
  prSnapshotFrom,
  pushEvents,
  pushSnapshotFrom,
} from "./events";
import type { RawApiCommit, RawPr } from "./events";
import type { PrSnapshot } from "./types";

const NOW = new Date("2026-08-09T12:00:00Z");
const OBSERVED = "2026-08-09T12:00:05Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function rawPr(overrides: Partial<RawPr> = {}): RawPr {
  return {
    number: 7,
    title: "feat: thing",
    author: { login: "alice" },
    headRefName: "claude/thing",
    headRefOid: SHA_A,
    isDraft: false,
    createdAt: "2026-08-09T10:00:00Z",
    updatedAt: "2026-08-09T11:00:00Z",
    mergedAt: null,
    closedAt: null,
    additions: 120,
    deletions: 4,
    changedFiles: 7,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [],
    url: "https://github.com/o/r/pull/7",
    ...overrides,
  };
}

/** Snapshots go through the real normaliser so the tests cannot drift from it. */
function snap(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return { ...prSnapshotFrom("o/r", rawPr(), NOW), ...overrides };
}

function kinds(events: ReturnType<typeof diffPrs>): string[] {
  return events.map((event) => event.kind);
}

describe("prSnapshotFrom", () => {
  it("maps GitHub's mergeability verdict onto the contract", () => {
    expect(prSnapshotFrom("o/r", rawPr({ mergeable: "MERGEABLE" }), NOW).conflict).toBe("clean");
    expect(prSnapshotFrom("o/r", rawPr({ mergeable: "CONFLICTING" }), NOW).conflict).toBe(
      "conflicting",
    );
    expect(prSnapshotFrom("o/r", rawPr({ mergeable: "UNKNOWN" }), NOW).conflict).toBe("unknown");
  });

  it("treats an absent mergeable as unknown rather than clean", () => {
    // A freshly pushed PR has none, and calling that clean would hide conflicts.
    expect(prSnapshotFrom("o/r", rawPr({ mergeable: undefined }), NOW).conflict).toBe("unknown");
  });

  it("keeps mergeStateStatus verbatim", () => {
    expect(prSnapshotFrom("o/r", rawPr({ mergeStateStatus: "BEHIND" }), NOW).mergeStateStatus).toBe(
      "BEHIND",
    );
  });

  it("reports no checks as none, not passing", () => {
    expect(prSnapshotFrom("o/r", rawPr({ statusCheckRollup: [] }), NOW).ci).toBe("none");
    // gh sends null when the repo has no checks configured at all.
    expect(prSnapshotFrom("o/r", rawPr({ statusCheckRollup: null }), NOW).ci).toBe("none");
  });

  it("counts FAILURE, ERROR and TIMED_OUT as failing, from either union member", () => {
    const pr = prSnapshotFrom(
      "o/r",
      rawPr({
        statusCheckRollup: [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" },
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT" },
          { __typename: "StatusContext", state: "ERROR" },
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      }),
      NOW,
    );
    expect(pr.ci).toBe("failing");
    expect(pr.ciFailing).toBe(3);
    expect(pr.ciTotal).toBe(4);
  });

  it("is pending while anything is still running", () => {
    const pr = prSnapshotFrom(
      "o/r",
      rawPr({
        statusCheckRollup: [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", name: "test", status: "IN_PROGRESS" },
        ],
      }),
      NOW,
    );
    expect(pr.ci).toBe("pending");
    expect(pr.ciFailing).toBe(0);
  });

  it("treats a StatusContext with no status field as pending on PENDING", () => {
    expect(
      prSnapshotFrom(
        "o/r",
        rawPr({ statusCheckRollup: [{ __typename: "StatusContext", state: "PENDING" }] }),
        NOW,
      ).ci,
    ).toBe("pending");
  });

  it("lets an observed failure outrank the checks still running", () => {
    const pr = prSnapshotFrom(
      "o/r",
      rawPr({
        statusCheckRollup: [
          { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
          { __typename: "CheckRun", status: "IN_PROGRESS" },
        ],
      }),
      NOW,
    );
    expect(pr.ci).toBe("failing");
  });

  it("derives state from the timestamps, merged before closed", () => {
    expect(prSnapshotFrom("o/r", rawPr(), NOW).state).toBe("open");
    expect(
      prSnapshotFrom("o/r", rawPr({ closedAt: "2026-08-09T11:00:00Z" }), NOW).state,
    ).toBe("closed");
    // A merged PR carries both, so mergedAt has to win.
    expect(
      prSnapshotFrom(
        "o/r",
        rawPr({ mergedAt: "2026-08-09T11:00:00Z", closedAt: "2026-08-09T11:00:00Z" }),
        NOW,
      ).state,
    ).toBe("merged");
  });

  it("does not mistake gh's zero time for a real timestamp", () => {
    const pr = prSnapshotFrom("o/r", rawPr({ mergedAt: "0001-01-01T00:00:00Z" }), NOW);
    expect(pr.state).toBe("open");
    expect(pr.mergedAt).toBeNull();
  });

  it("fills only the timestamps GitHub omitted, from the injected clock", () => {
    const pr = prSnapshotFrom("o/r", rawPr({ createdAt: undefined, updatedAt: undefined }), NOW);
    expect(pr.createdAt).toBe(NOW.toISOString());
    expect(pr.updatedAt).toBe(NOW.toISOString());
  });

  it("names the tier that attributed the coder", () => {
    expect(prSnapshotFrom("o/r", rawPr({ headRefName: "claude/x" }), NOW).coderSource).toBe(
      "branch",
    );
    expect(
      prSnapshotFrom(
        "o/r",
        rawPr({ headRefName: "deps", author: { login: "app/dependabot" } }),
        NOW,
      ).coderSource,
    ).toBe("login");
    const human = prSnapshotFrom("o/r", rawPr({ headRefName: "my-work" }), NOW);
    expect(human.coder).toBe("alice");
    expect(human.coderSource).toBe("fallback");
  });

  it("cannot reach the trailer tier, because gh pr list carries no commit bodies", () => {
    const pr = prSnapshotFrom("o/r", rawPr({ headRefName: "my-work" }), NOW);
    expect(pr.coderSource).not.toBe("trailer");
  });

  it("builds a url when gh omitted one", () => {
    expect(prSnapshotFrom("o/r", rawPr({ url: undefined }), NOW).url).toBe(
      "https://github.com/o/r/pull/7",
    );
  });
});

function rawCommit(overrides: Partial<RawApiCommit> = {}): RawApiCommit {
  return {
    sha: SHA_A,
    commit: {
      message: "fix: the thing\n\nlonger body\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      author: { date: "2026-08-01T09:00:00Z" },
      committer: { date: "2026-08-09T09:00:00Z" },
    },
    author: { login: "alice" },
    html_url: "https://github.com/o/r/commit/aaa",
    ...overrides,
  };
}

describe("pushSnapshotFrom", () => {
  it("uses the trailer, which is the whole reason the commits API is worth calling", () => {
    const push = pushSnapshotFrom("o/r", rawCommit(), NOW);
    expect(push.coder).toBe("claude");
    expect(push.coderSource).toBe("trailer");
  });

  it("keeps only the subject line", () => {
    expect(pushSnapshotFrom("o/r", rawCommit(), NOW).subject).toBe("fix: the thing");
  });

  it("prefers the committer date, since a rebase predates its landing", () => {
    expect(pushSnapshotFrom("o/r", rawCommit(), NOW).committedAt).toBe("2026-08-09T09:00:00Z");
  });

  it("falls back to the author login when no trailer matches", () => {
    const push = pushSnapshotFrom("o/r", rawCommit({ commit: { message: "chore: bump" } }), NOW);
    expect(push.coder).toBe("alice");
    expect(push.coderSource).toBe("fallback");
  });

  it("survives a commit whose email matches no account", () => {
    const push = pushSnapshotFrom(
      "o/r",
      rawCommit({ author: null, commit: { message: "chore: bump" }, html_url: undefined }),
      NOW,
    );
    expect(push.coder).toBe("unknown");
    expect(push.url).toBe(`https://github.com/o/r/commit/${SHA_A}`);
  });
});

describe("diffPrs cold start", () => {
  it("says nothing about a repo it has never seen", () => {
    // The single most important call in the module: adding a busy repo to the
    // watchlist must not replay its whole backlog as things that just happened.
    const open = [
      snap({ number: 1 }),
      snap({ number: 2 }),
      snap({ number: 3, state: "merged", mergedAt: "2026-07-01T00:00:00Z" }),
    ];
    expect(diffPrs([], open, OBSERVED)).toEqual([]);
  });

  it("baselines per repo, so one new repo does not ride in on another's history", () => {
    const known = snap({ repo: "o/known", number: 1 });
    const events = diffPrs(
      [known],
      [known, snap({ repo: "o/fresh", number: 1 }), snap({ repo: "o/fresh", number: 2 })],
      OBSERVED,
    );
    expect(events).toEqual([]);
  });

  it("still reports a genuinely new PR in a repo it already knows", () => {
    const known = snap({ number: 1 });
    const events = diffPrs([known], [known, snap({ number: 2 })], OBSERVED);
    expect(kinds(events)).toEqual(["pr-opened"]);
    expect(events[0].number).toBe(2);
    expect(events[0].at).toBe(known.createdAt);
    expect(events[0].observedAt).toBe(OBSERVED);
  });

  it("tells the whole story for a PR opened and merged inside one interval", () => {
    const events = diffPrs(
      [snap({ number: 1 })],
      [
        snap({ number: 1 }),
        snap({ number: 2, state: "merged", mergedAt: "2026-08-09T11:30:00Z" }),
      ],
      OBSERVED,
    );
    expect(kinds(events)).toEqual(["pr-opened", "pr-merged"]);
    expect(events[1].at).toBe("2026-08-09T11:30:00Z");
  });
});

describe("diffPrs transitions", () => {
  it("emits conflict-appeared and conflict-cleared on a real flip", () => {
    const before = snap();
    const conflicted = snap({ conflict: "conflicting", mergeStateStatus: "DIRTY" });
    expect(kinds(diffPrs([before], [conflicted], OBSERVED))).toEqual(["conflict-appeared"]);
    expect(kinds(diffPrs([conflicted], [before], OBSERVED))).toEqual(["conflict-cleared"]);
  });

  it("never turns an unknown into a conflict event, in either direction", () => {
    // GitHub computes mergeability lazily; UNKNOWN is it thinking, not news.
    const clean = snap({ conflict: "clean" });
    const unknown = snap({ conflict: "unknown", mergeStateStatus: "UNKNOWN" });
    const conflicting = snap({ conflict: "conflicting", mergeStateStatus: "DIRTY" });
    expect(diffPrs([clean], [unknown], OBSERVED)).toEqual([]);
    expect(diffPrs([unknown], [clean], OBSERVED)).toEqual([]);
    expect(diffPrs([unknown], [conflicting], OBSERVED)).toEqual([]);
    expect(diffPrs([conflicting], [unknown], OBSERVED)).toEqual([]);
  });

  it("does not let a round trip through unknown fabricate a second event", () => {
    const clean = snap({ conflict: "clean" });
    const unknown = snap({ conflict: "unknown" });
    expect(diffPrs([clean], [unknown], OBSERVED)).toEqual([]);
    expect(diffPrs([unknown], [clean], OBSERVED)).toEqual([]);
  });

  it("reports both when a PR conflicts and merges in the same cycle", () => {
    // Oldest intent first: the conflict was true before the merge landed, and
    // dropping it would hide that somebody had to resolve one to get in.
    const events = diffPrs(
      [snap()],
      [
        snap({
          conflict: "conflicting",
          mergeStateStatus: "DIRTY",
          state: "merged",
          mergedAt: "2026-08-09T11:45:00Z",
          headSha: SHA_B,
        }),
      ],
      OBSERVED,
    );
    expect(kinds(events)).toEqual(["conflict-appeared", "pr-merged"]);
    expect(events[1].at).toBe("2026-08-09T11:45:00Z");
  });

  it("orders ci before conflict before the lifecycle event", () => {
    const before = snap({ ci: "passing", ciTotal: 2 });
    const after = snap({
      ci: "failing",
      ciFailing: 1,
      ciTotal: 2,
      conflict: "conflicting",
      state: "closed",
    });
    expect(kinds(diffPrs([before], [after], OBSERVED))).toEqual([
      "ci-failed",
      "conflict-appeared",
      "pr-closed",
    ]);
  });

  it("emits ci-failed once, not on every cycle it stays red", () => {
    const red = snap({ ci: "failing", ciFailing: 1, ciTotal: 2 });
    expect(kinds(diffPrs([snap({ ci: "pending" })], [red], OBSERVED))).toEqual(["ci-failed"]);
    expect(diffPrs([red], [red], OBSERVED)).toEqual([]);
  });

  it("does not call a re-run a recovery", () => {
    // failing -> pending is another attempt starting, not the failure ending.
    const red = snap({ ci: "failing", ciFailing: 1, ciTotal: 2 });
    expect(diffPrs([red], [snap({ ci: "pending", ciTotal: 2 })], OBSERVED)).toEqual([]);
    expect(kinds(diffPrs([red], [snap({ ci: "passing", ciTotal: 2 })], OBSERVED))).toEqual([
      "ci-recovered",
    ]);
  });

  it("reports a reopen", () => {
    const closed = snap({ state: "closed" });
    expect(kinds(diffPrs([closed], [snap({ state: "open" })], OBSERVED))).toEqual(["pr-reopened"]);
  });

  it("emits pr-updated only when the new head is the only news", () => {
    expect(kinds(diffPrs([snap()], [snap({ headSha: SHA_B })], OBSERVED))).toEqual(["pr-updated"]);
    // A push that also broke the build is one event, not two ways of saying it.
    expect(
      kinds(
        diffPrs([snap()], [snap({ headSha: SHA_B, ci: "failing", ciFailing: 2 })], OBSERVED),
      ),
    ).toEqual(["ci-failed"]);
  });

  it("stays silent when nothing moved", () => {
    expect(diffPrs([snap()], [snap()], OBSERVED)).toEqual([]);
  });

  it("does not treat a PR falling off the paginated list as an event", () => {
    expect(diffPrs([snap({ number: 1 }), snap({ number: 2 })], [snap({ number: 1 })], OBSERVED))
      .toEqual([]);
  });

  it("carries the coder attribution onto the event", () => {
    const events = diffPrs([snap()], [snap({ headSha: SHA_B })], OBSERVED);
    expect(events[0].coder).toBe("claude");
    expect(events[0].coderSource).toBe("branch");
  });
});

describe("eventId", () => {
  it("re-derives identically from the same observation", () => {
    const previous = [snap()];
    const next = [
      snap({ conflict: "conflicting", state: "merged", mergedAt: "2026-08-09T11:45:00Z" }),
    ];
    const first = diffPrs(previous, next, "2026-08-09T12:00:05Z");
    const second = diffPrs(previous, next, "2026-08-09T12:05:05Z");
    expect(first.map((event) => event.id)).toEqual(second.map((event) => event.id));
    // observedAt differs between the two cycles and must not leak into the id.
    expect(first[0].observedAt).not.toBe(second[0].observedAt);
  });

  it("survives a re-derivation from a newer read of the same PR", () => {
    // The poller wrote events but crashed before storing snapshots: the next
    // cycle diffs the same stale previous against a PR whose updatedAt has
    // moved on. The merge must not appear in the feed twice.
    const previous = [snap()];
    const merged = { mergedAt: "2026-08-09T11:45:00Z", state: "merged" as const };
    const first = diffPrs(previous, [snap({ ...merged })], OBSERVED);
    const later = [snap({ ...merged, updatedAt: "2026-08-09T13:00:00Z" })];
    expect(dedupe(first, diffPrs(previous, later, OBSERVED))).toEqual([]);
  });

  it("keeps a lifecycle event's id independent of the head sha", () => {
    // Otherwise a push between two re-derivations duplicates the same open.
    expect(eventId({ kind: "pr-opened", repo: "o/r", number: 7, sha: SHA_A })).toBe(
      eventId({ kind: "pr-opened", repo: "o/r", number: 7, sha: SHA_B }),
    );
  });

  it("separates churn events by head sha", () => {
    expect(eventId({ kind: "ci-failed", repo: "o/r", number: 7, sha: SHA_A })).not.toBe(
      eventId({ kind: "ci-failed", repo: "o/r", number: 7, sha: SHA_B }),
    );
  });

  it("separates repos, numbers and kinds", () => {
    const base = { kind: "pr-merged" as const, repo: "o/r", number: 7, sha: SHA_A };
    expect(eventId(base)).not.toBe(eventId({ ...base, repo: "o/other" }));
    expect(eventId(base)).not.toBe(eventId({ ...base, number: 8 }));
    expect(eventId(base)).not.toBe(eventId({ ...base, kind: "pr-closed" }));
  });

  it("keys a push on its own sha", () => {
    expect(eventId({ kind: "push", repo: "o/r", number: null, sha: SHA_A })).toBe(
      `o/r#push:${SHA_A}`,
    );
  });
});

describe("pushEvents", () => {
  const commits = [
    pushSnapshotFrom("o/r", rawCommit({ sha: "c3", commit: { message: "third" } }), NOW),
    pushSnapshotFrom("o/r", rawCommit({ sha: "c2", commit: { message: "second" } }), NOW),
    pushSnapshotFrom("o/r", rawCommit({ sha: "c1", commit: { message: "first" } }), NOW),
  ];

  it("stops at the watermark and returns oldest first", () => {
    const events = pushEvents("c1", commits, OBSERVED);
    expect(events.map((event) => event.title)).toEqual(["second", "third"]);
    expect(events[0].kind).toBe("push");
    expect(events[0].number).toBeNull();
    expect(events[0].state).toBeNull();
  });

  it("emits nothing on a first sighting", () => {
    expect(pushEvents(null, commits, OBSERVED)).toEqual([]);
  });

  it("emits nothing when the watermark is the newest commit", () => {
    expect(pushEvents("c3", commits, OBSERVED)).toEqual([]);
  });

  it("re-emits everything when the watermark is gone, and lets dedupe sort it out", () => {
    // A force-push or a gap wider than the `since` window loses the anchor.
    const all = pushEvents("forgotten", commits, OBSERVED);
    expect(all).toHaveLength(3);
    expect(dedupe(pushEvents("c1", commits, OBSERVED), all).map((event) => event.title)).toEqual([
      "first",
    ]);
  });
});

describe("dedupe", () => {
  it("drops what the feed already holds", () => {
    const events = diffPrs([snap()], [snap({ headSha: SHA_B })], OBSERVED);
    expect(dedupe(events, events)).toEqual([]);
    expect(dedupe([], events)).toEqual(events);
  });

  it("drops repeats inside one batch too", () => {
    const [event] = diffPrs([snap()], [snap({ headSha: SHA_B })], OBSERVED);
    expect(dedupe([], [event, { ...event, observedAt: "2026-08-09T13:00:00Z" }])).toHaveLength(1);
  });

  it("leaves the surviving events untouched and in order", () => {
    const first = diffPrs([snap()], [snap({ headSha: SHA_B })], OBSERVED);
    const second = diffPrs(
      [snap()],
      [snap({ state: "merged", mergedAt: "2026-08-09T11:45:00Z" })],
      OBSERVED,
    );
    expect(dedupe(first, [...first, ...second])).toEqual(second);
  });
});
