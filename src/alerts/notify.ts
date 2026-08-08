/**
 * Local alerting.
 *
 * Deliberately offline: the report file on disk is the durable artifact and a
 * desktop notification is the nudge. Nothing here reaches the network, so the
 * tool works unchanged in an air-gapped environment and never ships repo
 * contents to a third party.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../engine/exec";
import { ensureHomeLayout, stateDir } from "../engine/paths";
import type { RunSummary } from "../store/store";

export interface AlertOutcome {
  notified: boolean;
  logged: boolean;
  reason?: string;
}

/** One line per alert, so history survives even when notifications do not. */
function appendAlertLog(line: string): void {
  ensureHomeLayout();
  appendFileSync(join(stateDir(), "alerts.log"), `${line}\n`, "utf8");
}

export function alertTitle(summary: RunSummary): string {
  return `Merge forensics — ${summary.repos.join(", ")}`;
}

/**
 * The alert body leads with whatever is worth acting on. A run where nothing
 * is wrong should say so plainly rather than dressing up green numbers.
 */
export function alertBody(summary: RunSummary): string {
  const parts: string[] = [`${summary.prCount} PRs`];
  const problems: string[] = [];
  if (summary.conflictedPrs.length > 0) {
    problems.push(`${summary.conflictRatePct}% conflicts (#${summary.conflictedPrs.join(", #")})`);
  }
  if (summary.crossCoderFreshOverwriteLines > 0) {
    problems.push(`${summary.crossCoderFreshOverwriteLines} cross-agent lines on fresh code`);
  }
  if (summary.reverts > 0) {
    problems.push(`${summary.reverts} revert${summary.reverts === 1 ? "" : "s"}`);
  }
  if (summary.churnRatePct >= 15) {
    problems.push(`${summary.churnRatePct}% churn`);
  }
  parts.push(problems.length ? problems.join(" · ") : "no conflicts, no cross-agent overwrites");
  return parts.join(" — ");
}

/** macOS `display notification`. Silently unavailable elsewhere. */
async function macNotify(title: string, body: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  // Quotes are escaped rather than interpolated raw: titles carry repo names
  // and PR numbers, and a stray quote would break the AppleScript.
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `display notification "${escape(body)}" with title "${escape(title)}"`;
  const result = await run("osascript", ["-e", script]);
  return result.code === 0;
}

export async function sendAlert(summary: RunSummary): Promise<AlertOutcome> {
  const title = alertTitle(summary);
  const body = alertBody(summary);
  appendAlertLog(
    JSON.stringify({ at: new Date().toISOString(), id: summary.id, title, body, report: summary.htmlPath }),
  );

  const notified = await macNotify(title, body);
  return {
    notified,
    logged: true,
    reason: notified
      ? undefined
      : process.platform === "darwin"
        ? "osascript refused (check notification permissions)"
        : `desktop notifications unsupported on ${process.platform}; alert written to the log`,
  };
}
