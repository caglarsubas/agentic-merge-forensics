import { describe, expect, it } from "vitest";

import { decideTrigger } from "./trigger";
import type { Watermark } from "../store/store";

const NOW = new Date("2026-08-08T12:00:00Z");

function watermark(overrides: Partial<Watermark> = {}): Watermark {
  return {
    key: "k",
    lastPrNumber: 100,
    lastRunAt: "2026-08-07T12:00:00Z",
    lastAlertAt: "2026-08-07T12:00:00Z",
    mergesSinceAlert: 0,
    ...overrides,
  };
}

describe("decideTrigger", () => {
  it("does not alert on the first sighting", () => {
    // Otherwise the very first run alerts about pre-existing history, which
    // says nothing about what changed.
    const decision = decideTrigger({
      key: "k",
      prNumbers: [1, 2, 3],
      previous: undefined,
      everyNMerges: 25,
      now: NOW,
    });
    expect(decision.shouldAlert).toBe(false);
    expect(decision.nextWatermark.lastPrNumber).toBe(3);
    expect(decision.nextWatermark.mergesSinceAlert).toBe(0);
  });

  it("counts only merges newer than the watermark", () => {
    const decision = decideTrigger({
      key: "k",
      prNumbers: [98, 99, 100, 101, 102],
      previous: watermark({ lastPrNumber: 100 }),
      everyNMerges: 25,
      now: NOW,
    });
    expect(decision.newMerges).toBe(2);
    expect(decision.shouldAlert).toBe(false);
    expect(decision.nextWatermark.mergesSinceAlert).toBe(2);
  });

  it("accumulates across runs until the threshold is reached", () => {
    const decision = decideTrigger({
      key: "k",
      prNumbers: [101, 102, 103],
      previous: watermark({ lastPrNumber: 100, mergesSinceAlert: 22 }),
      everyNMerges: 25,
      now: NOW,
    });
    expect(decision.shouldAlert).toBe(true);
    expect(decision.nextWatermark.lastAlertAt).toBe(NOW.toISOString());
  });

  it("keeps the remainder so a burst does not lose merges", () => {
    // 60 new merges against a threshold of 25 leaves 10 counting toward next.
    const decision = decideTrigger({
      key: "k",
      prNumbers: Array.from({ length: 60 }, (_, i) => 101 + i),
      previous: watermark({ lastPrNumber: 100 }),
      everyNMerges: 25,
      now: NOW,
    });
    expect(decision.shouldAlert).toBe(true);
    expect(decision.nextWatermark.mergesSinceAlert).toBe(10);
  });

  it("stays quiet when nothing merged", () => {
    const decision = decideTrigger({
      key: "k",
      prNumbers: [99, 100],
      previous: watermark({ lastPrNumber: 100 }),
      everyNMerges: 25,
      now: NOW,
    });
    expect(decision.shouldAlert).toBe(false);
    expect(decision.newMerges).toBe(0);
  });

  it("never moves the watermark backwards", () => {
    // A coder filter can make a later run see fewer PRs; that must not make
    // old merges look new again on the run after.
    const decision = decideTrigger({
      key: "k",
      prNumbers: [50],
      previous: watermark({ lastPrNumber: 100 }),
      everyNMerges: 25,
      now: NOW,
    });
    expect(decision.nextWatermark.lastPrNumber).toBe(100);
  });
});
