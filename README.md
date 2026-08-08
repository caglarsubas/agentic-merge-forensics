# agentic-merge-forensics

Merge-health forensics for repositories worked by coding agents.

When several agents (Claude, Codex, Cursor, …) open PRs against the same repo all
day, the interesting question is not "did CI pass" — it usually did. It is
whether they are quietly stepping on each other: how often merges actually
conflict, how much of what one agent lands another rewrites days later, and
which shared files everything collides in.

This measures that from git itself, not from PR metadata alone.

```bash
npm install
npx merge-forensics run --repo owner/name -n 50 --open
```

## What it measures

| Metric | How |
|---|---|
| **Conflict rate** | Replays every branch-update and final merge with `git merge-tree --write-tree`, so conflicts resolved *inside* a branch — which GitHub never shows and merged history hides — are counted too. |
| **Cross-agent overwrites** | `git blame` attributes every rewritten line to the PR that authored it, then maps that PR to a coder. Reported separately for code under 3 days old, which is the kind that indicates a race rather than maintenance. |
| **Churn** | Lines added in the window that a later in-window PR rewrote. |
| **Contention** | Files ranked by how many PRs touched them, and which concurrently-open PRs shared files. |
| **Process** | Cadence, time-to-merge, peak concurrent PRs, reverts, merges with failing checks, review coverage, merge-method split. |

Coders are identified from the branch prefix (`claude/…`), commit trailers
(`Co-Authored-By: Claude`), and bot logins — in that order. Add your own in
`src/engine/coder.ts`; nothing else needs to change.

## Usage

### One-off run

```bash
npx merge-forensics run --repo owner/name --repo other/name -n 50
```

Window — pick one (defaults to the 50 most recent merges):

```bash
npx merge-forensics run --repo owner/name --since 30d      # 30d, 12h, 2w, or 2026-08-01
npx merge-forensics run --repo owner/name -n 100
```

Filter to specific agents:

```bash
npx merge-forensics run --repo owner/name --coder claude,codex
```

Other flags: `--out <path>` to also write the HTML somewhere specific,
`--open` to open it, `--json` for machine-readable output, `--offline` to skip
the GitHub API and use git-derived metrics only.

### Automated runs with alerts

Alert once every 25 new merges, polling every 30 minutes:

```bash
npx merge-forensics watch --repo owner/name --every 25 --interval 30
```

The trigger counts **merges, not minutes** — a quiet week stays quiet, and a
burst of 60 merges alerts twice rather than once (the remainder carries
forward). Alerts are local only: a macOS notification plus an entry in
`~/.merge-forensics/state/alerts.log`, with the report on disk. Nothing leaves
the machine.

`--once` checks a single time and exits, which is what you want if you would
rather drive the schedule from cron or launchd.

### Web UI

```bash
npm run dev     # http://localhost:3737
```

Pick repos, window and coders; progress streams live while it runs; past runs
are listed with their headline numbers and a link to each report.

### Past runs

```bash
npx merge-forensics list
```

## How it stores things

Everything lives under `~/.merge-forensics` (override with
`MERGE_FORENSICS_HOME`):

```
clones/     bare mirrors, incrementally fetched — first run is the slow one
reports/    one directory per run: report.html + report.json
state/      run index, scheduler watermarks, alerts.log
```

Reports are self-contained HTML with no external requests, so they keep working
from a `file://` path or years later in an archive. They render in light and
dark; the categorical palette is validated for colour-vision separation against
each surface rather than picked by eye.

## Requirements

- Node 20+
- git **2.38+** — older git lacks `merge-tree --write-tree`, and the tool says
  so rather than silently reporting a 0% conflict rate
- `gh`, authenticated, for PR titles/authors/reviews. Without it the run still
  produces every git-derived metric and records a warning

## Honest limitations

These are surfaced in the report rather than buried:

- **A conflict resolved during a rebase leaves no trace in git.** Force-pushed
  PRs are counted and reported, and the conflict rate is described as a floor.
- **A squash-merged PR whose branch has been deleted cannot be replayed.** Those
  PRs are listed in the report's coverage notes instead of being counted clean.
- **Line attribution needs history beyond the window**, so the tool analyses a
  wider context than it reports on. Lines whose author still cannot be resolved
  are counted as *unattributed*, never as cross-agent — that distinction is what
  keeps the headline number meaningful.
- Generated and vendored files (lockfiles, snapshots, `dist/`, `vendor/`) are
  excluded from blame attribution.

## Development

```bash
npm test          # unit tests
npm run typecheck
npm run lint
```

The engine is deliberately split so the statistics are testable without a
repository: `discover`/`diff`/`coder`/`metrics` are pure functions, and
`git-queries`/`github` hold everything that shells out.

## Licence

Apache 2.0 — see [LICENSE](LICENSE).
