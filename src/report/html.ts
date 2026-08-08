/**
 * Renders a ForensicsReport as one self-contained HTML page.
 *
 * No external requests: styles are inlined and bars are laid out with CSS
 * widths rather than a chart library, so a report keeps working from a file://
 * path, in an air-gapped environment, or attached to an email years later.
 */
import type { ForensicsReport, PrAnalysis } from "../engine/types";
import { REPORT_CSS } from "./theme";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

/** Percent of a total, guarding the zero-total case. */
export function share(value: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((1000 * value) / total) / 10}%`;
}

function prLink(repoSlug: string | null, number: number): string {
  if (!repoSlug) return `<span class="mono">#${number}</span>`;
  return `<a class="pr" href="https://github.com/${escapeHtml(repoSlug)}/pull/${number}">#${number}</a>`;
}

interface BarItem {
  label: string;
  value: number;
  caption: string;
  highlight?: boolean;
}

function barRows(items: BarItem[], max: number, color = "var(--c1)"): string {
  const rows = items
    .map((item) => {
      // Leave room on the right for the value label so long numbers never
      // collide with the track's edge.
      const width = max > 0 ? Math.max(2, (item.value / max) * 72) : 2;
      const background = item.highlight ? "var(--c3)" : color;
      return `<div class="brow" title="${escapeHtml(item.label)}: ${escapeHtml(item.caption)}">
  <div class="bl">${escapeHtml(item.label)}</div>
  <div class="btrack">
    <div class="bfill" style="width:${width.toFixed(2)}%;background:${background}"></div>
    <span class="bval" style="left:calc(${width.toFixed(2)}% + 8px)">${escapeHtml(item.caption)}</span>
  </div>
</div>`;
    })
    .join("");
  return `<div class="bars">${rows}</div>`;
}

function stacked(items: Array<{ label: string; value: number; color: string }>): string {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return `<p class="small">Nothing to show.</p>`;
  const segments = items
    .filter((item) => item.value > 0)
    .map(
      (item) =>
        `<div style="flex:${item.value} 0 0;background:${item.color}" title="${escapeHtml(
          item.label,
        )}: ${formatNumber(item.value)} (${share(item.value, total)})"></div>`,
    )
    .join("");
  const legend = items
    .map(
      (item) =>
        `<span><span class="k" style="background:${item.color}"></span>${escapeHtml(
          item.label,
        )} <span class="mono">${formatNumber(item.value)} · ${share(item.value, total)}</span></span>`,
    )
    .join("");
  return `<div class="stack">${segments}</div><div class="legend">${legend}</div>`;
}

function tile(value: string, label: string, tone: "" | "good" | "warn" | "bad" = ""): string {
  return `<div class="tile ${tone}"><div class="v">${value}</div><div class="l">${label}</div></div>`;
}

/** Verdict wording tied to thresholds, so the same numbers always read alike. */
export function conflictVerdict(ratePct: number): "good" | "warn" | "bad" {
  if (ratePct <= 5) return "good";
  if (ratePct <= 15) return "warn";
  return "bad";
}

export function churnVerdict(ratePct: number): "good" | "warn" | "bad" {
  if (ratePct <= 5) return "good";
  if (ratePct <= 15) return "warn";
  return "bad";
}

export function renderReportHtml(report: ForensicsReport): string {
  const m = report.metrics;
  const singleRepo = report.repos.length === 1 ? report.repos[0] : null;
  const prNumbers = report.prs.map((pr) => pr.number);
  const rangeLabel = prNumbers.length
    ? `#${Math.min(...prNumbers)}–#${Math.max(...prNumbers)}`
    : "no PRs";

  const ageOrder = ["<=1d", "1-3d", "3-7d", "7-14d", ">14d"] as const;
  const ageLabels: Record<string, string> = {
    "<=1d": "≤ 1 day",
    "1-3d": "1–3 days",
    "3-7d": "3–7 days",
    "7-14d": "7–14 days",
    ">14d": "> 14 days",
  };
  const ageTotal = Object.values(m.rewriteAgeBuckets).reduce((sum, v) => sum + v, 0);
  const ageItems: BarItem[] = ageOrder.map((key) => ({
    label: ageLabels[key],
    value: m.rewriteAgeBuckets[key] ?? 0,
    caption: `${formatNumber(m.rewriteAgeBuckets[key] ?? 0)} · ${share(
      m.rewriteAgeBuckets[key] ?? 0,
      ageTotal,
    )}`,
  }));

  const conflictFiles = new Set(
    report.prs.flatMap((pr) => pr.conflicts.flatMap((c) => c.files)),
  );
  const hotItems: BarItem[] = m.hotFiles.slice(0, 12).map((file) => ({
    label: file.file.split("/").pop() ?? file.file,
    value: file.prCount,
    caption: `${file.prCount} PRs · ${formatNumber(file.crossPrLines)} cross-PR lines`,
    highlight: conflictFiles.has(file.file),
  }));

  const coderColors = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)"];
  const coderStack = m.coders.slice(0, 4).map((coder, index) => ({
    label: coder.coder,
    value: coder.prs,
    color: coderColors[index % coderColors.length],
  }));

  const freshMatrixRows = Object.entries(m.freshOverwriteMatrix)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(
      ([pair, lines]) =>
        `<tr><td>${escapeHtml(pair)}</td><td class="n">${formatNumber(lines)}</td></tr>`,
    )
    .join("");

  const conflictRows = report.prs
    .filter((pr) => pr.conflicts.length > 0)
    .flatMap((pr) =>
      pr.conflicts.map(
        (conflict) => `<tr>
  <td>${prLink(singleRepo, pr.number)}</td>
  <td>${escapeHtml(conflict.where)}</td>
  <td>${conflict.files.map((f) => `<div><code>${escapeHtml(f)}</code></div>`).join("")}</td>
</tr>`,
      ),
    )
    .join("");

  const concurrentRows = m.concurrentPairs
    .slice(0, 12)
    .map(
      (pair) => `<tr>
  <td>${prLink(singleRepo, pair.a)} + ${prLink(singleRepo, pair.b)}</td>
  <td class="n">${pair.overlapHours}h</td>
  <td>${pair.sharedFiles
    .slice(0, 4)
    .map((f) => `<div><code>${escapeHtml(f)}</code></div>`)
    .join("")}${pair.sharedFiles.length > 4 ? `<div class="faint">+${pair.sharedFiles.length - 4} more</div>` : ""}</td>
  <td>${pair.conflicted ? '<span class="chip bad">conflicted</span>' : ""}</td>
</tr>`,
    )
    .join("");

  const reworked = [...report.prs]
    .filter((pr) => pr.reworkedLines > 0)
    .sort((a, b) => b.reworkedLines - a.reworkedLines)
    .slice(0, 8)
    .map(
      (pr) => `<tr>
  <td>${prLink(singleRepo, pr.number)}</td>
  <td>${escapeHtml(pr.title.slice(0, 54))}</td>
  <td class="n">${formatNumber(pr.additions)}</td>
  <td class="n">${formatNumber(pr.reworkedLines)}</td>
  <td class="n">${share(pr.reworkedLines, Math.max(pr.additions, 1))}</td>
</tr>`,
    )
    .join("");

  const coderRows = m.coders
    .map(
      (coder) => `<tr>
  <td>${escapeHtml(coder.coder)}</td>
  <td class="n">${coder.prs}</td>
  <td class="n">${formatNumber(coder.additions)}</td>
  <td class="n">${coder.medianTimeToMergeHours ?? "—"}</td>
  <td class="n">${coder.conflicts}</td>
  <td class="n">${coder.branchUpdates + coder.forcePushes}</td>
  <td class="n">${coder.fixPrs}</td>
</tr>`,
    )
    .join("");

  const appendixRows = report.prs.map((pr) => appendixRow(pr, singleRepo)).join("");

  const warnings = report.warnings.length
    ? `<div class="warnbox"><b>Coverage notes</b><ul>${report.warnings
        .map((w) => `<li>${escapeHtml(w)}</li>`)
        .join("")}</ul></div>`
    : "";

  const conflictTone = conflictVerdict(m.conflictRatePct);
  const churnTone = churnVerdict(m.churnRatePct);

  return `<meta charset="utf-8">
<title>Merge forensics — ${escapeHtml(report.repos.join(", "))}</title>
<style>${REPORT_CSS}</style>
<div class="wrap">
<header>
  <div class="eyebrow">merge forensics · ${escapeHtml(report.repos.join(" · "))} · ${escapeHtml(
    (report.window.firstMergedAt ?? "").slice(0, 10),
  )} → ${escapeHtml((report.window.lastMergedAt ?? "").slice(0, 10))}</div>
  <h1>Merge health of ${report.prCount} PR merge${report.prCount === 1 ? "" : "s"}</h1>
  <p class="sub">PRs ${escapeHtml(rangeLabel)}${
    report.coderFilter ? `, filtered to ${escapeHtml(report.coderFilter.join(", "))}` : ""
  }. Conflicts are found by replaying every branch-update and final merge with
  <code>git merge-tree</code>; overwrites by attributing each rewritten line to its authoring PR with
  <code>git blame</code>. Generated ${escapeHtml(report.generatedAt.slice(0, 16).replace("T", " "))}.</p>

  <div class="tiles">
    ${tile(`${m.mergesPerDay}<span class="small"> /day</span>`, `merge cadence over ${report.window.spanDays} days, peak ${m.peakConcurrentOpen} open at once`)}
    ${tile(formatTtm(m.timeToMergeHours.median), `median time from open to merge (p90 ${m.timeToMergeHours.p90}h)`)}
    ${tile(`${m.conflictRatePct}%`, `conflict rate — ${m.conflictedPrs.length} of ${report.prCount} PRs hit a textual conflict`, conflictTone)}
    ${tile(
      formatNumber(m.crossCoderFreshOverwriteLines),
      "lines of &lt;3-day-old code rewritten <b>across</b> agents — the racing kind",
      m.crossCoderFreshOverwriteLines === 0 ? "good" : "warn",
    )}
    ${tile(`${m.churnRatePct}%`, `of ${formatNumber(m.totalAdded)} added lines were reworked again in-window`, churnTone)}
    ${tile(
      String(m.reverts.length + m.mergedWithFailingChecks.length),
      "reverts plus merges with a failing check",
      m.reverts.length + m.mergedWithFailingChecks.length === 0 ? "good" : "bad",
    )}
    ${tile(String(m.prsWithReview), `PRs with a human review approval, of ${report.prCount}`, m.prsWithReview === 0 ? "warn" : "")}
  </div>
  ${warnings}
</header>

<section>
  <div class="eyebrow">1 · Pipeline shape</div>
  <h2>Who merges, how fast, and how big</h2>
  <div class="grid2">
    <div>
      <h3>PRs by coder</h3>
      ${stacked(coderStack)}
      <h3>Merge method</h3>
      ${stacked([
        { label: "merge commit", value: m.mergeKinds.merge, color: "var(--c1)" },
        { label: "squash", value: m.mergeKinds.squash, color: "var(--c2)" },
      ])}
      <p class="small">A mixed split makes first-parent history, blame and bisect behave
      inconsistently across PRs.</p>
    </div>
    <div>
      <h3>Scale &amp; speed</h3>
      <table>
        <tr><th></th><th class="n">median</th><th class="n">p90</th><th class="n">max</th></tr>
        <tr><td>Lines added</td><td class="n">${formatNumber(m.additions.median)}</td><td class="n">${formatNumber(m.additions.p90)}</td><td class="n">${formatNumber(m.additions.max)}</td></tr>
        <tr><td>Lines deleted</td><td class="n">${formatNumber(m.deletions.median)}</td><td class="n">${formatNumber(m.deletions.p90)}</td><td class="n">${formatNumber(m.deletions.max)}</td></tr>
        <tr><td>Files changed</td><td class="n">${m.changedFiles.median}</td><td class="n">${m.changedFiles.p90}</td><td class="n">${m.changedFiles.max}</td></tr>
        <tr><td>Time to merge (h)</td><td class="n">${m.timeToMergeHours.median}</td><td class="n">${m.timeToMergeHours.p90}</td><td class="n">${m.timeToMergeHours.max}</td></tr>
        <tr><td>Commits</td><td class="n">${m.commits.median}</td><td class="n">${m.commits.p90}</td><td class="n">${m.commits.max}</td></tr>
      </table>
      <h3>Per coder</h3>
      <table>
        <tr><th>coder</th><th class="n">PRs</th><th class="n">added</th><th class="n">TTM h</th><th class="n">confl</th><th class="n">upkeep</th><th class="n">fixes</th></tr>
        ${coderRows}
      </table>
    </div>
  </div>
</section>

<section>
  <div class="eyebrow">2 · Conflicts</div>
  <h2>${m.conflictedPrs.length === 0 ? "No textual conflicts in this window" : `${m.conflictedPrs.length} PR${m.conflictedPrs.length === 1 ? "" : "s"} hit a real conflict`}</h2>
  <p class="sub">Every multi-parent commit on every PR branch is replayed, so conflicts resolved
  inside a branch — which GitHub never surfaces and the merged history hides — are counted too.</p>
  <div class="tiles">
    ${tile(`${m.conflictedPrs.length}<span class="small"> /${report.prCount}</span>`, "PRs with a replayed textual conflict", conflictTone)}
    ${tile(String(m.prsWithBranchUpdate), "PRs that merged the trunk in to stay current")}
    ${tile(String(m.prsWithForcePush), "PRs that force-pushed — a rebase hides any conflict it resolved")}
    ${tile(`${m.concurrentPairsSharingFiles}`, "concurrently-open PR pairs that touched the same file")}
  </div>
  ${conflictRows ? `<h3>Conflict events</h3><table><tr><th>PR</th><th>where</th><th>files</th></tr>${conflictRows}</table>` : ""}
  ${concurrentRows ? `<h3>Concurrent PRs sharing files</h3><table><tr><th>pair</th><th class="n">overlap</th><th>shared files</th><th></th></tr>${concurrentRows}</table>` : ""}
  ${m.prsWithForcePush > 0 ? `<p class="small">Because a rebase leaves no trace of a conflict it resolved, the ${m.conflictRatePct}% rate is a floor, not an exact figure.</p>` : ""}
</section>

<section>
  <div class="eyebrow">3 · Overwrites &amp; churn</div>
  <h2>How old was the code each PR rewrote?</h2>
  <p class="sub">${formatNumber(ageTotal)} pre-existing lines were rewritten across these PRs,
  attributed to the PR that authored them.</p>
  ${barRows(ageItems, Math.max(...Object.values(m.rewriteAgeBuckets), 1))}
  <div class="grid2">
    <div>
      <h3>Overwrites across agents</h3>
      <table>
        <tr><th>scope</th><th class="n">lines</th></tr>
        <tr><td>Same coder rewriting its own work</td><td class="n">${formatNumber(m.sameCoderOverwriteLines)}</td></tr>
        <tr><td>Across coders (all ages)</td><td class="n">${formatNumber(m.crossCoderOverwriteLines)}</td></tr>
        <tr><td><b>Across coders, code &lt; 3 days old</b></td><td class="n"><b>${formatNumber(m.crossCoderFreshOverwriteLines)}</b></td></tr>
        <tr><td>Unattributed (coder unknown on one side)</td><td class="n">${formatNumber(m.unattributedOverwriteLines)}</td></tr>
      </table>
      <p class="small">Rewriting month-old code across agents is ordinary maintenance. The bolded
      row is the one that indicates a race: one agent replacing what another landed days ago.</p>
      ${freshMatrixRows ? `<table><tr><th>fresh cross-agent flow</th><th class="n">lines</th></tr>${freshMatrixRows}</table>` : ""}
    </div>
    <div>
      <h3>Most-reworked PRs</h3>
      <table>
        <tr><th>PR</th><th>title</th><th class="n">added</th><th class="n">re-touched</th><th class="n">%</th></tr>
        ${reworked || `<tr><td colspan="5" class="small">No in-window rework.</td></tr>`}
      </table>
    </div>
  </div>
</section>

<section>
  <div class="eyebrow">4 · Contention</div>
  <h2>Files most PRs had to touch</h2>
  <p class="sub">Ranked by how many of the ${report.prCount} PRs modified them. An orange bar marks a
  file that appeared in a conflict.</p>
  ${barRows(hotItems, Math.max(...m.hotFiles.map((f) => f.prCount), 1))}
  <p class="small">${
    m.hotFiles[0]
      ? `<code>${escapeHtml(m.hotFiles[0].file)}</code> leads with ${m.hotFiles[0].prCount} PRs and ${formatNumber(m.hotFiles[0].crossPrLines)} cross-PR line rewrites.`
      : "No shared files."
  }</p>
  <h3>Composition</h3>
  <table>
    <tr><th>signal</th><th class="n">value</th></tr>
    <tr><td>Fix PRs (title starts with "fix")</td><td class="n">${m.fixPrs.length}</td></tr>
    <tr><td>Reverts</td><td class="n">${m.reverts.length}</td></tr>
    <tr><td>Merged with a failing check</td><td class="n">${m.mergedWithFailingChecks.length}</td></tr>
    <tr><td>Title types</td><td class="n">${escapeHtml(
      Object.entries(m.titleTypes)
        .map(([type, count]) => `${type} ${count}`)
        .join(" · ") || "—",
    )}</td></tr>
  </table>
</section>

<section>
  <div class="eyebrow">Appendix</div>
  <h2>All ${report.prCount} merges</h2>
  <p class="small">upkeep = branch-updates + force-pushes · rewrote = pre-existing lines this PR
  replaced · reworked = its own lines a later in-window PR replaced.</p>
  <div class="scrollbox"><table>
    <tr><th>PR</th><th>coder</th><th>method</th><th>title</th><th class="n">added</th>
        <th class="n">deleted</th><th class="n">files</th><th class="n">TTM h</th>
        <th class="n">upkeep</th><th class="n">confl</th><th class="n">rewrote</th><th class="n">reworked</th></tr>
    ${appendixRows}
  </table></div>
</section>

<footer>
Generated by agentic-merge-forensics. Conflicts via <code>git merge-tree --write-tree</code> replay of
branch-update and final merges; line attribution via <code>git blame</code> over a context window wider
than the analysed set. Limitations: conflicts resolved during a rebase leave no trace, so the conflict
rate is a floor; generated and vendored files are excluded from blame.
</footer>
</div>`;
}

function appendixRow(pr: PrAnalysis, repoSlug: string | null): string {
  const conflicted = pr.conflicts.length > 0;
  return `<tr${conflicted ? ' class="hotrow"' : ""}>
  <td>${repoSlug ? `<a class="pr" href="https://github.com/${escapeHtml(repoSlug)}/pull/${pr.number}">#${pr.number}</a>` : `#${pr.number}`}</td>
  <td>${escapeHtml(pr.coder)}</td>
  <td>${escapeHtml(pr.kind)}</td>
  <td title="${escapeHtml(pr.title)}">${escapeHtml(pr.title.slice(0, 60))}</td>
  <td class="n">${formatNumber(pr.additions)}</td>
  <td class="n">${formatNumber(pr.deletions)}</td>
  <td class="n">${pr.changedFiles}</td>
  <td class="n">${pr.timeToMergeHours ?? "—"}</td>
  <td class="n">${pr.branchUpdates + pr.forcePushes || ""}</td>
  <td class="n">${pr.conflicts.length || ""}</td>
  <td class="n">${pr.rewrittenLines ? formatNumber(pr.rewrittenLines) : ""}</td>
  <td class="n">${pr.reworkedLines ? formatNumber(pr.reworkedLines) : ""}</td>
</tr>`;
}

function formatTtm(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}<span class="small"> min</span>`;
  if (hours < 48) return `${hours}<span class="small"> h</span>`;
  return `${Math.round(hours / 24)}<span class="small"> d</span>`;
}
