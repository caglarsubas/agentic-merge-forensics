/**
 * CLI entry point.
 *
 * The commands are thin: everything substantive lives in the engine, the
 * report renderer and the store, all of which the web UI uses too.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyze } from "../engine/analyze";
import { run } from "../engine/exec";
import { forensicsHome } from "../engine/paths";
import { renderReportHtml } from "../report/html";
import { repoSlug, type RepoRef } from "../engine/types";
import {
  listRuns,
  readWatermarks,
  saveRun,
  watermarkKey,
  writeWatermark,
  type RunSummary,
} from "../store/store";
import { decideTrigger } from "../scheduler/trigger";
import { sendAlert } from "../alerts/notify";
import { ArgError, HELP, parseArgs, type ParsedArgs } from "./args";

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function progress(message: string): void {
  // Progress goes to stderr so `--json` stdout stays machine-readable.
  process.stderr.write(`  ${message}\n`);
}

function requireRepos(args: ParsedArgs): RepoRef[] {
  if (args.repos.length === 0) {
    throw new ArgError("at least one --repo is required, e.g. --repo owner/name");
  }
  return args.repos;
}

async function runAnalysis(args: ParsedArgs) {
  const repos = requireRepos(args);
  const report = await analyze({
    repos,
    count: args.count,
    since: args.since,
    coders: args.coders,
    offline: args.offline,
    onProgress: progress,
  });
  const html = renderReportHtml(report);
  const saved = saveRun(report, html);
  if (args.out) {
    const target = resolve(args.out);
    writeFileSync(target, html, "utf8");
  }
  return { report, saved, html };
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const { report, saved } = await runAnalysis(args);
  const m = report.metrics;

  if (args.json) {
    out(JSON.stringify(saved.summary, null, 2));
  } else {
    out("");
    out(`  ${report.prCount} PRs across ${report.repos.join(", ")} over ${report.window.spanDays} days`);
    out(`  conflict rate        ${m.conflictRatePct}%  ${formatList(m.conflictedPrs)}`);
    out(`  cross-agent (fresh)  ${m.crossCoderFreshOverwriteLines} lines`);
    out(`  churn                ${m.churnRatePct}% of ${m.totalAdded.toLocaleString("en-US")} added lines`);
    out(`  median time to merge ${m.timeToMergeHours.median}h   cadence ${m.mergesPerDay}/day`);
    out(`  reverts ${m.reverts.length} · merged-with-failing-checks ${m.mergedWithFailingChecks.length} · reviewed ${m.prsWithReview}/${report.prCount}`);
    for (const warning of report.warnings) out(`  ! ${warning}`);
    out("");
    out(`  report: ${args.out ? resolve(args.out) : saved.htmlPath}`);
  }

  if (args.open) await openPath(args.out ? resolve(args.out) : saved.htmlPath);
  return 0;
}

async function cmdWatch(args: ParsedArgs): Promise<number> {
  const repos = requireRepos(args);
  const key = watermarkKey(repos.map(repoSlug), args.coders);
  out(
    `watching ${repos.map(repoSlug).join(", ")} — alerting every ${args.everyNMerges} new merges, polling every ${args.intervalMinutes} min`,
  );
  out(`state: ${forensicsHome()}`);

  for (;;) {
    try {
      const { report, saved } = await runAnalysis(args);
      const decision = decideTrigger({
        key,
        prNumbers: report.prs.map((pr) => pr.number),
        previous: readWatermarks()[key],
        everyNMerges: args.everyNMerges,
        now: new Date(),
      });
      writeWatermark(decision.nextWatermark);

      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      if (decision.shouldAlert) {
        const outcome = await sendAlert(saved.summary);
        out(`[${stamp}] ALERT — ${decision.reason}; report ${saved.htmlPath}`);
        if (!outcome.notified && outcome.reason) out(`[${stamp}] note: ${outcome.reason}`);
      } else {
        out(`[${stamp}] ${decision.reason}`);
      }
    } catch (error) {
      // A transient failure (network, rate limit) must not end the watch.
      out(`[${new Date().toISOString().slice(0, 16).replace("T", " ")}] run failed: ${(error as Error).message}`);
    }

    if (args.once) return 0;
    await sleep(args.intervalMinutes * 60_000);
  }
}

function cmdList(args: ParsedArgs): number {
  const runs = listRuns();
  if (args.json) {
    out(JSON.stringify(runs, null, 2));
    return 0;
  }
  if (runs.length === 0) {
    out("no runs yet — try: merge-forensics run --repo owner/name");
    return 0;
  }
  out(`${runs.length} run(s) in ${forensicsHome()}`);
  for (const summary of runs.slice(0, 25)) out(`  ${formatRunLine(summary)}`);
  return 0;
}

export function formatRunLine(summary: RunSummary): string {
  const when = summary.generatedAt.slice(0, 16).replace("T", " ");
  return [
    when,
    summary.repos.join(","),
    `${summary.prCount} PRs`,
    `conflicts ${summary.conflictRatePct}%`,
    `churn ${summary.churnRatePct}%`,
    summary.crossCoderFreshOverwriteLines > 0
      ? `cross-agent ${summary.crossCoderFreshOverwriteLines}`
      : "cross-agent 0",
  ].join("  ");
}

function formatList(numbers: number[]): string {
  return numbers.length ? `(#${numbers.join(", #")})` : "";
}

async function openPath(path: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  await run(opener, [path]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve_) => setTimeout(resolve_, ms));
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (args.help || !args.command) {
    out(HELP);
    return args.command ? 0 : args.help ? 0 : 1;
  }

  try {
    switch (args.command) {
      case "run":
        return await cmdRun(args);
      case "watch":
        return await cmdWatch(args);
      case "list":
        return cmdList(args);
      case "serve":
        out("Start the UI with:  npm run dev   (then open http://localhost:3737)");
        return 0;
      default:
        process.stderr.write(`unknown command "${args.command}"\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ArgError) {
      process.stderr.write(`${error.message}\n\n${HELP}`);
      return 2;
    }
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  },
);
