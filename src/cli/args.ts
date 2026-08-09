/**
 * Argument parsing, kept separate from the commands so the flag semantics can
 * be tested directly — including the combinations that should be rejected.
 */
import { parseRepoRef, type RepoRef } from "../engine/types";

export interface ParsedArgs {
  command: string;
  repos: RepoRef[];
  count?: number;
  since?: Date;
  coders: string[] | null;
  everyNMerges: number;
  intervalMinutes: number;
  out?: string;
  open: boolean;
  offline: boolean;
  json: boolean;
  once: boolean;
  /** feed: keep polling rather than running a single cycle. */
  watch: boolean;
  help: boolean;
}

export class ArgError extends Error {}

/** `30d`, `12h`, `2w`, or an ISO date. */
export function parseSince(value: string, now: Date = new Date()): Date {
  const relative = /^(\d+)\s*([hdw])$/i.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unitHours = { h: 1, d: 24, w: 168 }[relative[2].toLowerCase() as "h" | "d" | "w"];
    return new Date(now.getTime() - amount * unitHours * 3_600_000);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ArgError(`could not read --since "${value}" (try 30d, 12h, 2w or 2026-08-01)`);
  }
  return parsed;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseArgs(argv: readonly string[], now: Date = new Date()): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "",
    repos: [],
    coders: null,
    everyNMerges: 25,
    intervalMinutes: 30,
    open: false,
    offline: false,
    json: false,
    once: false,
    watch: false,
    help: false,
  };

  const rest = [...argv];
  parsed.command = rest[0] && !rest[0].startsWith("-") ? (rest.shift() as string) : "";

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = () => {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ArgError(`${arg} needs a value`);
      }
      i++;
      return value;
    };

    switch (arg) {
      case "--repo":
      case "--repos":
        parsed.repos.push(...splitList(next()).map(parseRepoRef));
        break;
      case "--count":
      case "-n": {
        const value = Number(next());
        if (!Number.isInteger(value) || value <= 0) {
          throw new ArgError("--count must be a positive integer");
        }
        parsed.count = value;
        break;
      }
      case "--since":
        parsed.since = parseSince(next(), now);
        break;
      case "--coder":
      case "--coders":
        parsed.coders = splitList(next()).map((coder) => coder.toLowerCase());
        break;
      case "--every":
        parsed.everyNMerges = requirePositive(next(), "--every");
        break;
      case "--interval":
        parsed.intervalMinutes = requirePositive(next(), "--interval");
        break;
      case "--out":
        parsed.out = next();
        break;
      case "--open":
        parsed.open = true;
        break;
      case "--offline":
        parsed.offline = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--watch":
        parsed.watch = true;
        break;
      case "--once":
        parsed.once = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      default:
        throw new ArgError(`unknown option ${arg}`);
    }
  }

  if (parsed.count !== undefined && parsed.since !== undefined) {
    throw new ArgError("--count and --since select the window in different ways; pick one");
  }
  if (parsed.count === undefined && parsed.since === undefined) {
    parsed.count = 50;
  }
  return parsed;
}

function requirePositive(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ArgError(`${flag} must be a positive integer`);
  }
  return parsed;
}

export const HELP = `merge-forensics — merge health for repos worked by coding agents

USAGE
  merge-forensics run   --repo owner/name [--repo other/name] [options]
  merge-forensics watch --repo owner/name [--every 25] [--interval 30]
  merge-forensics feed  [--watch]
  merge-forensics list  [--json]
  merge-forensics serve

WINDOW (pick one; defaults to --count 50)
  -n, --count <n>        analyse the most recent n PR merges
      --since <when>     analyse everything merged since 30d / 12h / 2w / 2026-08-01

FILTERS
      --coder <list>     keep only these coders, e.g. claude,codex,cursor

OUTPUT
      --out <path>       write the HTML report here as well as the run store
      --open             open the report when it is finished
      --json             print machine-readable output

BEHAVIOUR
      --offline          skip the GitHub API; git-derived metrics only
      --every <n>        (watch) alert once this many new merges accumulate
      --interval <min>   (watch) how often to poll
      --once             (watch) check a single time and exit
      --watch            (feed) keep polling; otherwise one cycle and exit

FEED
  The activity feed follows the repos on its watchlist and records what the
  agents do: pull requests opening and landing, direct pushes, conflicts and CI.
  Manage the watchlist in the web UI. Poll interval comes from
  MERGE_FORENSICS_FEED_INTERVAL (seconds, default 60).

Reports and state live in ~/.merge-forensics (override with MERGE_FORENSICS_HOME).
`;
