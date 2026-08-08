/**
 * Attributing a PR to the agent (or human) that wrote it.
 *
 * There is no single reliable signal, so this checks several in order of how
 * much they actually mean:
 *
 *   1. Branch prefix   — `claude/foo`, `codex/bar`, `cursor/baz`. Strongest
 *                        signal in practice: the harness picks it, not a human.
 *   2. Commit trailers — `Co-Authored-By: Claude <...>`. Survives squashing.
 *   3. Bot authors     — `app/dependabot`, `*[bot]`.
 *   4. Fallback        — the GitHub login, so human PRs group by person.
 *
 * The rules are data, not code, so a team can add its own agent without
 * touching the engine.
 */

export interface CoderRule {
  /** Label reported to the user. */
  coder: string;
  /** Matched case-insensitively against the head branch name. */
  branchPrefixes?: string[];
  /** Matched case-insensitively against commit message trailers. */
  trailerPatterns?: string[];
  /** Matched case-insensitively against the PR author login. */
  authorLogins?: string[];
}

export const DEFAULT_CODER_RULES: CoderRule[] = [
  {
    coder: "claude",
    branchPrefixes: ["claude"],
    trailerPatterns: ["claude", "anthropic"],
  },
  {
    coder: "codex",
    branchPrefixes: ["codex"],
    trailerPatterns: ["codex", "openai"],
  },
  {
    coder: "cursor",
    branchPrefixes: ["cursor"],
    trailerPatterns: ["cursor"],
  },
  {
    coder: "copilot",
    branchPrefixes: ["copilot"],
    trailerPatterns: ["copilot"],
    authorLogins: ["copilot", "github-copilot[bot]"],
  },
  {
    coder: "devin",
    branchPrefixes: ["devin"],
    trailerPatterns: ["devin"],
  },
  {
    coder: "dependabot",
    branchPrefixes: ["dependabot"],
    authorLogins: ["app/dependabot", "dependabot[bot]"],
  },
];

export interface CoderSignals {
  headRefName?: string | null;
  /** Full commit messages for the PR's commits, trailers included. */
  commitMessages?: readonly string[];
  authorLogin?: string | null;
}

function branchPrefix(headRefName: string): string | null {
  const slash = headRefName.indexOf("/");
  return slash === -1 ? null : headRefName.slice(0, slash).toLowerCase();
}

/**
 * Resolve the coder for one PR. Returns the author login when no rule matches,
 * and "unknown" when there is nothing to go on — never a silent default that
 * would inflate one agent's share.
 */
export function detectCoder(
  signals: CoderSignals,
  rules: readonly CoderRule[] = DEFAULT_CODER_RULES,
): string {
  const head = (signals.headRefName ?? "").toLowerCase();
  const prefix = head ? branchPrefix(head) : null;
  if (prefix) {
    for (const rule of rules) {
      if (rule.branchPrefixes?.some((p) => p.toLowerCase() === prefix)) {
        return rule.coder;
      }
    }
  }

  const login = (signals.authorLogin ?? "").toLowerCase();
  if (login) {
    for (const rule of rules) {
      if (rule.authorLogins?.some((a) => a.toLowerCase() === login)) {
        return rule.coder;
      }
    }
  }

  const messages = (signals.commitMessages ?? []).join("\n").toLowerCase();
  if (messages) {
    // Only trailer lines count. A commit body that merely mentions an agent by
    // name is not evidence that agent wrote it.
    const trailers = messages
      .split("\n")
      .filter((line) => /^(co-authored-by|signed-off-by|generated-by):/i.test(line.trim()));
    const trailerText = trailers.join("\n");
    if (trailerText) {
      for (const rule of rules) {
        if (rule.trailerPatterns?.some((p) => trailerText.includes(p.toLowerCase()))) {
          return rule.coder;
        }
      }
    }
  }

  if (login) return login;
  return "unknown";
}

/** Every coder label a rule set can produce, for UI filters. */
export function knownCoders(rules: readonly CoderRule[] = DEFAULT_CODER_RULES): string[] {
  return rules.map((r) => r.coder);
}
