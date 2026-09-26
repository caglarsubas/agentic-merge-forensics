/**
 * Checks a model-written summary against the facts it was written from.
 *
 * The prompt hands the model every number pre-counted, and it mostly copies
 * them — but a small model still recombines them: "five from codex in X and one
 * in Y" when codex has four in X and one in Y, or "all from codex" when one of
 * six is someone else's. Every number in those sentences exists in the data, so
 * checking numbers on their own catches almost nothing. What is wrong is what a
 * number is attached to. So this reads each number together with the coder or
 * repo the sentence attaches it to, and checks that pair against the group the
 * sentence is about (conflicts or failing CI).
 *
 * It is a heuristic over the phrasing the model actually produces, not a parser
 * of English. A number it cannot attach to anything is only checked for being
 * a number the data contains at all; it errs towards letting prose through.
 */
import type { PrGroup, SummaryFacts } from "./summary";

interface Pr {
  repo: string;
  number: number;
  coder: string;
  checks: number;
}

type Token =
  | { kind: "repo"; name: string }
  | { kind: "coder"; name: string }
  | { kind: "num"; value: number; text: string }
  | { kind: "word"; text: string }
  | { kind: "comma" }
  | { kind: "ref"; number: number }
  | { kind: "stop"; end: boolean; char: string };

type Num = Extract<Token, { kind: "num" }>;

const WORDS: Record<string, number> = {
  zero: 0, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

/** "one" and "single" double as ordinary words ("one of them", "a single repo"),
 *  so they are only trusted where a sentence attaches them to something. */
const AMBIGUOUS = new Set(["one", "single"]);
const ALL_WORDS = new Set(["all", "every", "entirely", "exclusively", "solely"]);
const CONFLICT_WORDS = new Set(["conflict", "conflicts", "conflicting", "conflicted", "cleanly"]);
const FAILING_WORDS = new Set(["fail", "fails", "failing", "failed", "failure", "failures", "ci", "check", "checks"]);
/** Words that start an independent clause after a comma or dash: "…are stuck, and X is failing CI". */
const JOINERS = new Set(["and", "but", "while", "whereas", "yet"]);

class Reader {
  readonly tokens: Token[] = [];
  readonly problems = new Set<string>();
  private readonly clauseOf: number[] = [];
  private readonly topics: Array<Pr[][]> = [];
  private readonly aboutGroups: boolean[] = [];
  /** PR numbers the text names, and the clause each is in. */
  readonly refs: Array<{ number: number; repo: string | null; clause: number }> = [];

  constructor(
    text: string,
    readonly facts: SummaryFacts,
    readonly conflicting: Pr[],
    readonly failing: Pr[],
  ) {
    const coders = new Set([...conflicting, ...failing].map((pr) => pr.coder));
    for (const filter of facts.filtersApplied) {
      if (filter.startsWith("agents: ")) filter.slice(8).split(", ").forEach((c) => coders.add(c));
    }
    const repos = new Set([...conflicting, ...failing].map((pr) => pr.repo).concat(facts.repos));

    // Which group each clause is about, from the words it uses. Clauses, not
    // sentences: "codex's five are stuck, and dependabot's PR is failing CI"
    // talks about both groups, and only its second half is about CI. A clause
    // after ":" or a dash spells out the one before it and inherits its topic;
    // one after ", and", "while" or ";" stands on its own.
    const clauses: Array<{ words: Set<string>; parent: number | null }> = [{ words: new Set(), parent: null }];
    let current = 0;
    const open = (parent: number | null) => {
      clauses.push({ words: new Set(), parent });
      current = clauses.length - 1;
    };
    const raw = tokenise(text, [...repos], [...coders]);
    for (const [k, token] of raw.entries()) {
      const next = raw[k + 1];
      const joins = next?.kind === "word" && JOINERS.has(next.text);
      if (token.kind === "ref") {
        const before = this.tokens.at(-1);
        this.refs.push({ number: token.number, repo: before?.kind === "repo" ? before.name : null, clause: current });
        continue;
      }
      if (token.kind === "stop") {
        if (token.end || token.char === ";") open(null);
        else if (token.char === ":") open(current);
        else if ("—–-".includes(token.char.trim())) open(joins ? null : current);
      } else if (token.kind === "comma" && joins) {
        open(null);
      } else if (token.kind === "word" && (token.text === "while" || token.text === "whereas")) {
        open(null);
      }
      this.tokens.push(token);
      this.clauseOf.push(current);
      if (token.kind === "word") clauses[current].words.add(token.text);
    }

    const own = (c: number) => {
      const words = [...clauses[c].words];
      return { c: words.some((w) => CONFLICT_WORDS.has(w)), f: words.some((w) => FAILING_WORDS.has(w)) };
    };
    for (let c = 0; c < clauses.length; c++) {
      let at: number | null = c;
      let found = own(c);
      while (!found.c && !found.f && at !== null) {
        at = clauses[at].parent;
        if (at !== null) found = own(at);
      }
      const topic = found.c && !found.f ? [conflicting] : found.f && !found.c ? [failing] : [conflicting, failing];
      this.topics[c] = topic.filter((group) => group.length);
      this.aboutGroups[c] = found.c || found.f;
    }

    // "acme/web#12 is failing CI" must name a PR that is failing CI.
    for (const ref of this.refs) {
      const matches = (pr: Pr) => refersTo(ref, pr);
      if (this.topics[ref.clause].some((group) => group.some(matches))) continue;
      const label = `${ref.repo ?? ""}#${ref.number}`;
      this.problems.add(
        [conflicting, failing].some((group) => group.some(matches))
          ? `${label} is named in a sentence about the other group`
          : `${label} is not a PR in the data`,
      );
    }
  }

  /** The PR groups the clause containing token `i` is talking about. */
  groupsAt(i: number): Pr[][] {
    return this.topics[this.clauseOf[i]] ?? [];
  }

  /** The PR groups clause number `clause` is talking about. */
  topicOf(clause: number): Pr[][] {
    return this.topics[clause] ?? [];
  }

  /** Whether that clause is about conflicts or CI at all, rather than activity. */
  isAboutGroups(i: number): boolean {
    return this.aboutGroups[this.clauseOf[i]] ?? false;
  }

  /** Whether `repos` names every repo with activity and every repo with a flagged PR,
   *  so that the window's totals are totals for that list. */
  coversAll(repos: string[]): boolean {
    const every = new Set([...this.facts.repos, ...[...this.conflicting, ...this.failing].map((pr) => pr.repo)]);
    return every.size > 0 && [...every].every((repo) => repos.includes(repo));
  }

  get allGroups(): Pr[][] {
    return [this.conflicting, this.failing].filter((group) => group.length);
  }

  word(i: number): string | null {
    const token = this.tokens[i];
    return token?.kind === "word" ? token.text : null;
  }

  name(i: number): string {
    return (this.tokens[i] as { name: string }).name;
  }
}

/** Everything wrong with `text`, as sentences a person or the model can act on. */
export function checkSummary(text: string, facts: SummaryFacts): string[] {
  const normalised = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[*`]/g, "");
  const reader = new Reader(normalised, facts, parse(facts.conflictingNow), parse(facts.failingCiNow));
  const allowed = allowedNumbers(facts, reader.allGroups);

  for (const [i, token] of reader.tokens.entries()) {
    if (token.kind === "num" && !AMBIGUOUS.has(token.text) && !allowed.has(token.value)) {
      reader.problems.add(`"${token.text}" is not a number anywhere in the data`);
    }
    if (token.kind === "coder") checkCoder(reader, i);
    if (token.kind === "repo") checkRepo(reader, i);
    if (token.kind === "word" && ALL_WORDS.has(token.text)) checkAll(reader, i);
  }
  checkTotals(reader);
  checkZeroClaims(normalised, facts, reader.problems);
  checkInventedNames(normalised, reader);
  checkCompleteness(reader);
  return [...reader.problems];
}

/**
 * A summary built from the facts alone, for when the model cannot produce one
 * that passes. Plain, but every number in it is right.
 */
export function templateSummary(facts: SummaryFacts): string {
  const parts: string[] = [];
  if (facts.conflictingNow.count) {
    parts.push(`Conflicting with their base branch: ${facts.conflictingNow.description}.`);
  }
  if (facts.failingCiNow.count) parts.push(`Failing CI: ${facts.failingCiNow.description}.`);
  if (!parts.length) parts.push("Nothing needs attention: no conflicting PRs and no failing CI.");
  const pushes = facts.directPushes === 1 ? "direct push" : "direct pushes";
  parts.push(
    `In ${facts.window}: ${facts.merged} merged, ${facts.opened} opened, ` +
      `${facts.directPushes} ${pushes}, ${facts.openPrs} open now.`,
  );
  return parts.join(" ");
}

const LABEL = /^(.+)#(\d+) by (.+?)(?: \((\d+) checks? failing\))?$/;

function parse(group: PrGroup): Pr[] {
  return group.prs.flatMap((label) => {
    const match = LABEL.exec(label);
    return match
      ? [{ repo: match[1], number: Number(match[2]), coder: match[3], checks: Number(match[4] ?? 0) }]
      : [];
  });
}

function tokenise(text: string, repos: string[], coders: string[]): Token[] {
  // PR numbers become their own tokens, and the brackets around a bare list of
  // them ("(#50, #51)") go, so they do not break up a list of repos.
  let marked = text
    .replace(/#(\d+)/g, " \u0002$1\u0002 ")
    .replace(/\(((?:\s|,|and|\u0002\d+\u0002)*)\)/g, " $1 ");
  // Longest first, so a full slug wins over its own short name.
  const names = [
    ...repos.flatMap((repo) => [
      { name: repo, alias: repo, kind: "r" },
      { name: repo, alias: repo.split("/").pop() ?? repo, kind: "r" },
    ]),
    ...coders.map((coder) => ({ name: coder, alias: coder, kind: "c" })),
  ].sort((a, b) => b.alias.length - a.alias.length);
  const lookup: string[] = [];
  for (const { name, alias, kind } of names) {
    const pattern = new RegExp(`(?<![\\w/.-])${escape(alias)}(?![\\w-]|/\\w)`, "g");
    marked = marked.replace(pattern, () => {
      lookup.push(name);
      return ` \u0001${kind}${lookup.length - 1}\u0001 `;
    });
  }

  const tokens: Token[] = [];
  const pattern =
    /\u0001([rc])(\d+)\u0001|\u0002(\d+)\u0002|\d+|[a-z]+(?:-[a-z]+)*|'s|,|[.;:!?()—–]|\s-\s/g;
  for (const [raw, kind, index, ref] of marked.matchAll(pattern)) {
    if (kind) tokens.push({ kind: kind === "r" ? "repo" : "coder", name: lookup[Number(index)] });
    else if (ref) tokens.push({ kind: "ref", number: Number(ref) });
    else if (/^\d+$/.test(raw)) tokens.push({ kind: "num", value: Number(raw), text: raw });
    else if (raw in WORDS) tokens.push({ kind: "num", value: WORDS[raw], text: raw });
    else if (raw === ",") tokens.push({ kind: "comma" });
    else if (/^[a-z']/.test(raw)) tokens.push({ kind: "word", text: raw });
    else tokens.push({ kind: "stop", end: /[.!?]/.test(raw), char: raw.trim() || raw });
  }
  return tokens;
}

function refersTo(ref: { number: number; repo: string | null }, pr: Pr): boolean {
  return pr.number === ref.number && (ref.repo === null || pr.repo === ref.repo);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The counts that describe the window as a whole rather than any one group. */
function totals(facts: SummaryFacts): number[] {
  return [
    facts.events,
    facts.merged,
    facts.opened,
    facts.directPushes,
    facts.ciFailures,
    facts.openPrs,
    facts.conflictingNow.count,
    facts.failingCiNow.count,
  ];
}

/** Every count a sentence could legitimately quote. */
function allowedNumbers(facts: SummaryFacts, groups: Pr[][]): Set<number> {
  const allowed = new Set<number>([
    0,
    ...totals(facts),
    facts.repos.length,
    ...(facts.window.match(/\d+/g) ?? []).map(Number),
  ]);
  for (const group of groups) {
    allowed.add(group.reduce((sum, pr) => sum + pr.checks, 0));
    group.forEach((pr) => allowed.add(pr.checks));
    for (const key of [(pr: Pr) => pr.coder, (pr: Pr) => pr.repo]) {
      const counts = countBy(group, key);
      allowed.add(counts.size);
      counts.forEach((n) => allowed.add(n));
    }
    for (const coder of new Set(group.map((pr) => pr.coder))) {
      const own = group.filter((pr) => pr.coder === coder);
      allowed.add(new Set(own.map((pr) => pr.repo)).size);
      countBy(own, (pr) => pr.repo).forEach((n) => allowed.add(n));
    }
  }
  return allowed;
}

function countBy(prs: Pr[], key: (pr: Pr) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pr of prs) counts.set(key(pr), (counts.get(key(pr)) ?? 0) + 1);
  return counts;
}

function count(group: Pr[], coder: string | null, repos: string[] | null): number {
  return group.filter(
    (pr) => (coder === null || pr.coder === coder) && (repos === null || repos.includes(pr.repo)),
  ).length;
}

function codersIn(group: Pr[]): string[] {
  return [...new Set(group.map((pr) => pr.coder))];
}

/** The nearest number at or before `from`, within the clause, not crossing a name. */
function numberBefore(reader: Reader, from: number): { num: Num; each: boolean } | null {
  let each = false;
  for (let j = from; j >= 0 && j > from - 4; j--) {
    const token = reader.tokens[j];
    if (token.kind === "stop" || token.kind === "coder" || token.kind === "repo") return null;
    if (token.kind === "word" && token.text === "each") each = true;
    if (token.kind === "num") return { num: token, each };
  }
  return null;
}

/** "a/x (4)" or "a/x (4 PRs)" — but not "a/x (3 checks failing)", which counts checks. */
function parenthetical(reader: Reader, repoAt: number): { num: Num; end: number } | null {
  const t = reader.tokens;
  const [open, num, next] = [t[repoAt + 1], t[repoAt + 2], t[repoAt + 3]];
  if (open?.kind !== "stop" || num?.kind !== "num") return null;
  if (next?.kind === "stop") return { num, end: repoAt + 4 };
  const unit = reader.word(repoAt + 3);
  if ((unit === "pr" || unit === "prs") && t[repoAt + 4]?.kind === "stop") return { num, end: repoAt + 5 };
  return null;
}

/**
 * The repos listed from `start`: "a/x", "the a/x and a/y repos", "a/x, a/y and
 * a/z". A list stops where the next item carries its own number ("a/x and one
 * in a/y"), because that number then belongs to that repo alone.
 */
function repoList(reader: Reader, start: number): string[] {
  const t = reader.tokens;
  const list: string[] = [];
  let p = reader.word(start) === "the" ? start + 1 : start;
  while (t[p]?.kind === "repo") {
    list.push(reader.name(p));
    p = parenthetical(reader, p)?.end ?? p + 1;
    while (t[p]?.kind === "comma" || reader.word(p) === "and" || reader.word(p) === "the") p++;
  }
  return list;
}

/** Skips "'s", "prs", "conflicting" and the like between a coder and what follows. */
function skipFiller(reader: Reader, p: number): number {
  const filler = new Set(["'s", "pr", "prs", "pull", "requests", "conflicting", "failing", "open", "new"]);
  while (filler.has(reader.word(p) ?? "")) p++;
  return p;
}

function checkCoder(reader: Reader, i: number): void {
  const coder = reader.name(i);
  const t = reader.tokens;
  const prev = reader.word(i - 1);

  let claim: Num | null = null;
  let after = skipFiller(reader, i + 1);
  if (prev === "from" || prev === "by" || prev === "of" || (prev === "in" && reader.word(i + 1) === "'s")) {
    // "five from codex", "5 PRs by codex", "five of codex's PRs", "three in cursor's PR"
    claim = numberBefore(reader, i - 2)?.num ?? null;
  } else if (t[i - 1]?.kind === "num") {
    // "six codex PRs"
    claim = t[i - 1] as Num;
  } else {
    // "codex has 6", "claude's two", "codex has opened five"
    for (let j = i + 1; j <= i + 4 && t[j]; j++) {
      const token = t[j];
      if (token.kind === "num") {
        claim = token;
        after = skipFiller(reader, j + 1);
        break;
      }
      if (token.kind !== "word" || ["and", "or", "in", "from", "with", "each"].includes(token.text)) break;
    }
  }

  // Whatever repos the sentence places this coder's PRs in, if any.
  const link = reader.word(after);
  const where = link === "in" || link === "across" ? repoList(reader, after + 1) : [];
  const scope = where.length ? where : null;
  const groups = reader.groupsAt(i);

  // "claude's PRs in a/x and a/y": each repo named must hold one of claude's PRs.
  if (scope && (claim || reader.word(i + 1) === "'s" || prev === "from" || prev === "by")) {
    const stray = scope.filter((repo) => !groups.some((group) => count(group, coder, [repo]) > 0));
    if (stray.length && groups.length) {
      reader.problems.add(`${coder} has no PR in ${stray.join(" or ")} that this sentence is about`);
      return;
    }
  }
  if (!claim) return;
  const value = claim.value;
  if (groups.some((group) => count(group, coder, scope) === value)) return;

  const actual = groups.map((group) => count(group, coder, scope)).filter((n) => n > 0);
  reader.problems.add(
    `"${claim.text}" is attached to ${coder}${scope ? ` in ${scope.join(" and ")}` : ""}, ` +
      `but the data has ${actual.length ? actual.join(" or ") : "none"} there`,
  );
}

function checkRepo(reader: Reader, i: number): void {
  const t = reader.tokens;
  // Only the first repo of a list carries the count before it.
  if (t[i - 1]?.kind === "repo" || t[i - 1]?.kind === "comma") return;
  if (reader.word(i - 1) === "and" && t[i - 2]?.kind === "repo") return;

  const link = reader.word(i - 1) === "the" ? i - 2 : i - 1;
  const list = repoList(reader, i);
  const claims: Array<{ num: Num; each: boolean; repos: string[] }> = [];
  // "four in a/x", "one each in a/x and a/y"
  if (["in", "across", "at", "on"].includes(reader.word(link) ?? "")) {
    const before = numberBefore(reader, link - 1);
    if (before) claims.push({ ...before, repos: list });
  }
  // "a/x (4)"
  const own = parenthetical(reader, i);
  if (own) claims.push({ num: own.num, each: false, repos: [reader.name(i)] });

  const groups = reader.groupsAt(i);
  // Naming every repo with activity makes the window's totals apply to it:
  // "two PRs remain open in a/x" when a/x is the only repo.
  const coversAll = reader.coversAll(list);

  for (const { num, each, repos } of claims) {
    if (coversAll && totals(reader.facts).includes(num.value)) continue;
    const fits = (group: Pr[], coder: string | null) =>
      each
        ? repos.every((repo) => count(group, coder, [repo]) === num.value)
        : count(group, coder, repos) === num.value;
    if (groups.some((group) => fits(group, null) || codersIn(group).some((c) => fits(group, c)))) continue;

    const actual = [...new Set(groups.flatMap((group) => repos.map((repo) => count(group, null, [repo]))))];
    reader.problems.add(
      `"${num.text}${each ? " each" : ""}" is attached to ${repos.join(" and ")}, ` +
        `but the data has ${actual.filter((n) => n > 0).join(" or ") || "none"} there`,
    );
  }
}

/** "all from codex" / "all in a/x" must be literally true of some group or coder. */
function checkAll(reader: Reader, i: number): void {
  const t = reader.tokens;
  for (let j = i + 1; j < t.length && !(t[j].kind === "stop" && (t[j] as { end: boolean }).end); j++) {
    if (reader.word(j) === "except") return;
  }
  const word = reader.word(i);
  const groups = reader.groupsAt(i);
  for (let j = i + 1; j <= i + 5 && t[j] && t[j].kind !== "stop"; j++) {
    const token = t[j];
    const link = reader.word(j - 1);
    if (token.kind === "coder" && (link === "from" || link === "by")) {
      if (!groups.some((group) => group.every((pr) => pr.coder === token.name))) {
        reader.problems.add(`"${word} from ${token.name}" is not true: others are in that group too`);
      }
      return;
    }
    if (token.kind === "repo" && (link === "in" || link === "across" || link === "the")) {
      const repos = repoList(reader, j);
      const within = (prs: Pr[]) => prs.length > 0 && prs.every((pr) => repos.includes(pr.repo));
      // "activity was entirely in a/x" is about events, not a group of PRs.
      // With no flagged PRs at all, it can only be about events.
      const eventsWithin = (!reader.isAboutGroups(i) || !groups.length) && reader.coversAll(repos);
      const ok =
        eventsWithin ||
        groups.some(
          (group) =>
            within(group) || codersIn(group).some((c) => within(group.filter((pr) => pr.coder === c))),
        );
      if (!ok) reader.problems.add(`"${word} in ${repos.join(" and ")}" is not true of any group or coder`);
      return;
    }
  }
}

/**
 * "10 merged", "6 PRs opened", "pushed directly 3 times", "one was merged": a
 * number stated as how many were merged, opened or pushed must be that total.
 * "one" is trusted here because the sentence says what it counts.
 */
function checkTotals(reader: Reader): void {
  const facts = reader.facts;
  const kinds: Array<[RegExp, number, string]> = [
    [/^(merged|merges)$/, facts.merged, "merged"],
    [/^(opened|openings)$/, facts.opened, "opened"],
    [/^(pushes|pushed|direct-pushed|push)$/, facts.directPushes, "direct pushes"],
  ];
  const filler = new Set(["pr", "prs", "pull", "requests", "were", "was", "have", "been", "new", "direct", "directly", "times"]);
  const kindOf = (i: number) => kinds.find(([pattern]) => pattern.test(reader.word(i) ?? ""));
  const t = reader.tokens;
  for (const [i, token] of t.entries()) {
    if (token.kind !== "num") continue;
    // A number with a coder or repo attached is checked there instead.
    const next = t[i + 1];
    if (next?.kind === "word" && ["from", "by", "in", "of", "each"].includes(next.text)) continue;
    let kind: (typeof kinds)[number] | undefined;
    for (let j = i + 1; j <= i + 4 && !kind; j++) {
      kind = kindOf(j);
      if (!kind && !filler.has(reader.word(j) ?? "")) break;
    }
    for (let j = i - 1; j >= i - 2 && !kind; j--) {
      kind = kindOf(j);
      if (!kind && !filler.has(reader.word(j) ?? "")) break;
    }
    if (kind && token.value !== kind[1]) {
      reader.problems.add(`"${token.text}" is given as ${kind[2]}, but the data has ${kind[1]}`);
    }
  }
}

/**
 * "one from agent-001": asked who opened PRs the facts do not attribute, the
 * model makes up numbered names. Anything name-like with a digit in it after
 * "from" or "by" has to be a coder or repo from the data.
 */
function checkInventedNames(text: string, reader: Reader): void {
  const known = new Set(
    [...reader.allGroups.flat().flatMap((pr) => [pr.coder, pr.repo, pr.repo.split("/").pop() ?? ""]),
      ...reader.facts.repos.flatMap((repo) => [repo, repo.split("/").pop() ?? ""])],
  );
  for (const [, name] of text.matchAll(/\b(?:from|by)\s+([a-z][\w.-]*\d[\w.-]*)/g)) {
    const bare = name.replace(/[.-]+$/, "");
    if (!known.has(bare)) reader.problems.add(`"${bare}" is not a coder or repo in the data`);
  }
}

/**
 * Every coder with a flagged PR has to be named in a sentence about that group,
 * or have one of those PRs named by number there. Dropping someone reads as a
 * clean bill of health for their work: "five from codex are in conflict", with
 * refik-ergun's conflict silently left out.
 */
function checkCompleteness(reader: Reader): void {
  const t = reader.tokens;
  // "claude's PR conflicts, and their other PR fails CI" names claude twice.
  const pronouns = new Set(["their", "they", "them", "its", "his", "her"]);
  const antecedent = (i: number): string | null => {
    for (let j = i - 1; j >= 0; j--) {
      const token = t[j];
      if (token.kind === "stop" && token.end) return null;
      if (token.kind === "coder") return token.name;
    }
    return null;
  };
  const groups = [
    [reader.conflicting, "conflicting"],
    [reader.failing, "failing-CI"],
  ] as const;
  for (const [group, label] of groups) {
    for (const coder of codersIn(group)) {
      const named = t.some(
        (token, i) =>
          reader.groupsAt(i).includes(group) &&
          ((token.kind === "coder" && token.name === coder) ||
            (token.kind === "word" && pronouns.has(token.text) && antecedent(i) === coder)),
      );
      const referenced = reader.refs.some(
        (ref) =>
          reader.topicOf(ref.clause).includes(group) &&
          group.some((pr) => pr.coder === coder && refersTo(ref, pr)),
      );
      if (named || referenced) continue;
      const own = group.filter((pr) => pr.coder === coder);
      const repos = [...new Set(own.map((pr) => pr.repo))].join(", ");
      reader.problems.add(
        `${coder}'s ${label} ${own.length === 1 ? "PR is" : `${own.length} PRs are`} left out (${repos})`,
      );
    }
  }
}

/** "no merges" when there were merges is a wrong number too: zero. */
function checkZeroClaims(text: string, facts: SummaryFacts, problems: Set<string>): void {
  const claims: Array<[string, number, string]> = [
    ["merges|merged prs|prs merged|merged pull requests", facts.merged, "merged"],
    ["pushes|direct pushes", facts.directPushes, "direct pushes"],
    ["new prs|new pull requests|prs opened|opened prs", facts.opened, "opened"],
    ["conflicts|conflicting prs|merge conflicts", facts.conflictingNow.count, "conflicting now"],
    ["ci failures|failing ci|failing checks|failing ci checks", facts.failingCiNow.count, "failing CI now"],
  ];
  for (const [core, actual, label] of claims) {
    if (actual === 0) continue;
    const pattern = new RegExp(
      `\\bno\\s(?:[^.;:!?—–()]{0,40}?(?:\\bor\\b|\\band\\b|,)\\s)?(?:new\\s|direct\\s)?(?:${core})\\b`,
      "g",
    );
    for (const [match] of text.matchAll(pattern)) {
      // "no other conflicts" and "nothing else" are about the rest, not the total.
      if (/\b(other|else|beyond|further|more)\b/.test(match)) continue;
      problems.add(`"${match}" contradicts the data: ${actual} ${label}`);
    }
  }
}
