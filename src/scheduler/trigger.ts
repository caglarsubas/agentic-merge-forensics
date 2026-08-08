/**
 * When should an automated run fire an alert?
 *
 * The trigger the user asked for is "every N new PR merges", which is not the
 * same as "every N minutes": a quiet week should stay quiet, and a burst of 60
 * merges should alert twice rather than once. Kept pure so the counting rules
 * are testable without a clock or a repository.
 */
import type { Watermark } from "../store/store";

export interface TriggerDecision {
  shouldAlert: boolean;
  newMerges: number;
  /** Carries the running count forward when the threshold is not yet met. */
  nextWatermark: Watermark;
  reason: string;
}

export interface TriggerInput {
  key: string;
  /** PR numbers currently present, newest run. */
  prNumbers: number[];
  previous: Watermark | undefined;
  /** Alert once this many new merges have accumulated. */
  everyNMerges: number;
  now: Date;
}

export function decideTrigger(input: TriggerInput): TriggerDecision {
  const { key, prNumbers, previous, everyNMerges, now } = input;
  const highest = prNumbers.length ? Math.max(...prNumbers) : 0;

  if (!previous) {
    // First sighting establishes the baseline. Alerting here would fire on
    // whatever history happened to exist, which says nothing about activity.
    return {
      shouldAlert: false,
      newMerges: 0,
      reason: "baseline established; counting new merges from here",
      nextWatermark: {
        key,
        lastPrNumber: highest,
        lastRunAt: now.toISOString(),
        lastAlertAt: null,
        mergesSinceAlert: 0,
      },
    };
  }

  const newMerges = prNumbers.filter((number) => number > previous.lastPrNumber).length;
  const accumulated = previous.mergesSinceAlert + newMerges;

  if (accumulated < everyNMerges) {
    return {
      shouldAlert: false,
      newMerges,
      reason: `${accumulated}/${everyNMerges} merges since the last alert`,
      nextWatermark: {
        ...previous,
        lastPrNumber: Math.max(highest, previous.lastPrNumber),
        lastRunAt: now.toISOString(),
        mergesSinceAlert: accumulated,
      },
    };
  }

  // Keep the remainder rather than zeroing it: 60 merges against a threshold
  // of 25 should not silently discard the extra 10.
  return {
    shouldAlert: true,
    newMerges,
    reason: `${accumulated} new merges reached the threshold of ${everyNMerges}`,
    nextWatermark: {
      ...previous,
      lastPrNumber: Math.max(highest, previous.lastPrNumber),
      lastRunAt: now.toISOString(),
      lastAlertAt: now.toISOString(),
      mergesSinceAlert: accumulated % everyNMerges,
    },
  };
}
