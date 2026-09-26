/**
 * Executive summary of the feed, written by a local model.
 *
 * Two rules shape this module.
 *
 * The facts are derived on the server from the stored feed, never taken from
 * the caller. The page sends only the filter it is looking through; if it sent
 * the numbers too, the summary would describe whatever the client claimed
 * rather than what actually happened.
 *
 * And the model is given a small, closed set of already-computed facts rather
 * than raw events. It is there to phrase, not to count — a language model asked
 * to tally forty events will occasionally get it wrong, and a confident wrong
 * number in an executive summary is worse than no summary at all.
 */
import { createHash } from "node:crypto";
import { checkSummary, templateSummary } from "./summary-check";
import type { FeedEvent, PrSnapshot } from "./types";

export interface SummaryFilter {
  /** Inclusive epoch millis. */
  from: number;
  to: number;
  windowLabel: string;
  coders?: string[];
  repos?: string[];
  onlyConflicting?: boolean;
  onlyFailing?: boolean;
}

export interface SummaryFacts {
  window: string;
  events: number;
  merged: number;
  opened: number;
  directPushes: number;
  ciFailures: number;
  openPrs: number;
  conflictingNow: PrGroup;
  failingCiNow: PrGroup;
  repos: string[];
  filtersApplied: string[];
}

/**
 * A set of open PRs whose counts are already written out as a phrase. Given a
 * bare list, the model counted and grouped it badly: six conflicts, five of them
 * codex's, came back as "six PRs, all from codex". Given the counts as separate
 * coder and repo splits, it still recombined them wrongly ("codex has 6", "five
 * in repo X" when it was four and one), so repos are named without counts.
 * Copying a finished phrase is the one thing a small model does reliably.
 */
export interface PrGroup {
  count: number;
  /** e.g. "6 PRs: 5 from codex, in a/x and a/y; 1 from bob, in b/z". */
  description: string;
  prs: string[];
}

export interface SummaryResult {
  summary: string;
  facts: SummaryFacts;
  /** Stable over identical facts, so a poll that changed nothing can reuse it. */
  fingerprint: string;
  model: string;
  /** "template" when every model draft failed the check and the facts were
   *  written out plainly instead. */
  source: "model" | "template";
  /** Model calls made, including rejected drafts. */
  attempts: number;
  cached: boolean;
  elapsedMs: number;
}

const SYSTEM_PROMPT = [
  "You write a short executive summary for an engineering lead who runs several AI",
  "coding agents across shared repositories.",
  "",
  "Two or three sentences. Plain English. No bullet points, no headings, no markdown,",
  "no preamble, no sign-off.",
  "",
  "Lead with whatever needs a human decision: conflicting PRs, then failing checks.",
  "If nothing needs attention, say so plainly and briefly.",
  "",
  "Use ONLY the facts in the data. Never invent a repository name, a pull request",
  "number, a cause or a count. An empty list means none, not unknown.",
  "",
  "Every number is already counted and worded for you: conflictingNow.description",
  "and failingCiNow.description say exactly how many, from whom and where.",
  "Keep each number with the coder or repo it is paired with there. You may shorten",
  "or reword, but never regroup, recount, add numbers together or estimate. If no",
  "field gives a number, say it without one. Say \"all\", \"every\", \"only\" or",
  "\"entirely\" about a group only when its description does. When you say where a",
  "coder's PRs are, name every repo the description lists for them, or none. Repos",
  "carry no counts in the data; name them without numbers.",
  "",
  "A conflict means the PR no longer merges cleanly into its base branch. The data",
  "does not say what it conflicts with, so never say it clashes with, overlaps or",
  "rewrites another agent's or PR's work.",
].join("\n");

/** Only what the model is allowed to talk about, already counted. */
export function extractFacts(
  events: readonly FeedEvent[],
  prs: readonly PrSnapshot[],
  filter: SummaryFilter,
): SummaryFacts {
  const inWindow = events.filter((event) => {
    const at = Date.parse(event.observedAt);
    if (at < filter.from || at > filter.to) return false;
    if (filter.coders?.length && !filter.coders.includes(event.coder)) return false;
    if (filter.repos?.length && !filter.repos.includes(event.repo)) return false;
    if (filter.onlyConflicting && event.conflict !== "conflicting") return false;
    if (filter.onlyFailing && event.ci !== "failing") return false;
    return true;
  });

  const open = prs.filter((pr) => pr.state === "open");
  const scoped = (pr: PrSnapshot) =>
    (!filter.repos?.length || filter.repos.includes(pr.repo)) &&
    (!filter.coders?.length || filter.coders.includes(pr.coder));

  const conflicting = open.filter((pr) => scoped(pr) && pr.conflict === "conflicting");
  const failing = open.filter((pr) => scoped(pr) && pr.ci === "failing");

  const filtersApplied: string[] = [];
  if (filter.repos?.length) filtersApplied.push(`repositories: ${filter.repos.join(", ")}`);
  if (filter.coders?.length) filtersApplied.push(`agents: ${filter.coders.join(", ")}`);
  if (filter.onlyConflicting) filtersApplied.push("conflicting only");
  if (filter.onlyFailing) filtersApplied.push("failing CI only");

  return {
    window: filter.windowLabel,
    events: inWindow.length,
    merged: inWindow.filter((event) => event.kind === "pr-merged").length,
    opened: inWindow.filter((event) => event.kind === "pr-opened").length,
    directPushes: inWindow.filter((event) => event.kind === "push").length,
    ciFailures: inWindow.filter((event) => event.kind === "ci-failed").length,
    openPrs: open.filter(scoped).length,
    conflictingNow: group(conflicting, (pr) => `${pr.repo}#${pr.number} by ${pr.coder}`),
    failingCiNow: group(
      failing,
      (pr) =>
        `${pr.repo}#${pr.number} by ${pr.coder} ` +
        `(${pr.ciFailing} ${pr.ciFailing === 1 ? "check" : "checks"} failing)`,
    ),
    repos: [...new Set(inWindow.map((event) => event.repo))],
    filtersApplied,
  };
}

/** Key → count, largest first. */
function tally<T>(items: readonly T[], key: (item: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function group(prs: readonly PrSnapshot[], label: (pr: PrSnapshot) => string): PrGroup {
  return { count: prs.length, description: describe(prs), prs: prs.map(label) };
}

function describe(prs: readonly PrSnapshot[]): string {
  if (prs.length === 0) return "none";
  const byCoder = tally(prs, (pr) => pr.coder).map(([coder, n]) => {
    const repos = tally(
      prs.filter((pr) => pr.coder === coder),
      (pr) => pr.repo,
    ).map(([repo]) => repo);
    return { coder, n, where: `in ${and(repos)}` };
  });
  const total = `${prs.length} ${prs.length === 1 ? "PR" : "PRs"}`;
  if (byCoder.length === 1) {
    const [only] = byCoder;
    const who = prs.length === 1 ? `from ${only.coder}` : `all from ${only.coder}`;
    return `${total}, ${who}, ${only.where}`;
  }
  const parts = byCoder.map(({ coder, n, where }) => `${n} from ${coder}, ${where}`);
  return `${total}: ${parts.join("; ")}`;
}

function and(items: string[]): string {
  return items.length > 1
    ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
    : items[0];
}

/** Identical facts must produce an identical key, so polling costs nothing. */
export function fingerprint(facts: SummaryFacts, model: string): string {
  return createHash("sha1").update(`${model}\n${JSON.stringify(facts)}`).digest("hex").slice(0, 16);
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  /** "ollama" talks to /api/chat, "openai" to /v1/chat/completions. */
  flavour: "ollama" | "openai";
  timeoutMs: number;
}

export function llmConfig(): LlmConfig {
  const baseUrl = (
    process.env.MERGE_FORENSICS_LLM_URL ?? "http://127.0.0.1:11434"
  ).replace(/\/+$/, "");
  const declared = process.env.MERGE_FORENSICS_LLM_API;
  // An OpenAI-compatible gateway is conventionally mounted under /v1; anything
  // else here is Ollama's native API, which is the only one that can turn the
  // reasoning trace off.
  const flavour: "ollama" | "openai" =
    declared === "openai" || declared === "ollama"
      ? declared
      : /\/v1$/.test(baseUrl)
        ? "openai"
        : "ollama";
  return {
    baseUrl,
    flavour,
    model: process.env.MERGE_FORENSICS_LLM_MODEL ?? "ministral-3:8b",
    apiKey: process.env.MERGE_FORENSICS_LLM_KEY ?? null,
    timeoutMs: Number(process.env.MERGE_FORENSICS_LLM_TIMEOUT_MS ?? 45_000),
  };
}

/**
 * The default, ministral-3:8b, has no reasoning trace, so neither path below
 * pays for one. The settings matter when a reasoning model such as gemma4 is
 * configured instead, and the two paths differ in what they can do about it.
 *
 * Ollama takes `think: false` and stops generating the trace altogether: about
 * 60 completion tokens and a second for a two-sentence answer.
 *
 * An OpenAI-compatible gateway cannot. Measured against the local inference
 * engine, `reasoning_effort: "none"` and `chat_template_kwargs.thinking=false`
 * are both accepted and neither stops it: `reasoning_content` comes back empty
 * while 1900-2700 completion tokens are spent producing a 240-character
 * answer. The trace is discarded, not skipped. So the budget there has to
 * cover thinking the caller never sees — at max_tokens 2000 it lands right on
 * the edge and intermittently returns nothing at all.
 */
export interface WrittenSummary {
  text: string;
  source: "model" | "template";
  attempts: number;
  /** What was wrong with each rejected draft, oldest first. */
  rejected: string[][];
}

/** One draft plus up to two corrections before giving up on the model. */
const MAX_ATTEMPTS = 3;

type Message = { role: "system" | "user" | "assistant"; content: string };

/**
 * Asks for a summary, checks every number in it against the facts, and on a
 * mismatch tells the model exactly what was wrong and asks again. If no draft
 * passes, the facts are written out plainly rather than showing a wrong one.
 *
 * Only the first call's failure propagates — that means the model is down or
 * unreachable. A failure on a correction round falls back like a rejection.
 */
export async function writeSummary(
  facts: SummaryFacts,
  config: LlmConfig = llmConfig(),
): Promise<WrittenSummary> {
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Summarise this activity:\n${JSON.stringify(facts, null, 1)}` },
  ];
  const started = Date.now();
  const rejected: string[][] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let text: string;
    try {
      text = await chat(messages, config);
    } catch (caught) {
      if (attempt === 1) throw caught;
      break;
    }
    const problems = checkSummary(text, facts);
    if (!problems.length) return { text, source: "model", attempts: attempt, rejected };
    rejected.push(problems);
    // Corrections share the one time budget, so a slow model falls back
    // instead of tripling the wait.
    if (Date.now() - started > config.timeoutMs) break;
    messages.push(
      { role: "assistant", content: text },
      {
        role: "user",
        content:
          `That summary has errors:\n${problems.map((p) => `- ${p}`).join("\n")}\n` +
          "Write it again. Take every number from conflictingNow.description and " +
          "failingCiNow.description exactly as written there, with the same coder and " +
          "repos, and state no number the data does not give.",
      },
    );
  }
  return { text: templateSummary(facts), source: "template", attempts: rejected.length, rejected };
}

async function chat(messages: Message[], config: LlmConfig): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const isOllama = config.flavour === "ollama";
    const url = isOllama
      ? `${config.baseUrl}/api/chat`
      : `${config.baseUrl}/chat/completions`;
    const body = isOllama
      ? {
          model: config.model,
          stream: false,
          think: false,
          options: { temperature: 0.2, num_predict: 400 },
          messages,
        }
      : {
          model: config.model,
          stream: false,
          temperature: 0.2,
          max_tokens: 4000,
          reasoning_effort: "none",
          messages,
        };

    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`llm ${response.status}: ${detail.slice(0, 160)}`);
    }

    const json = (await response.json()) as {
      message?: { content?: string };
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = (json.message?.content ?? json.choices?.[0]?.message?.content ?? "").trim();
    if (!text) {
      throw new Error(
        "the model returned no text — it likely spent its budget on reasoning; " +
          "raise MERGE_FORENSICS_LLM_TIMEOUT_MS or use a model without a reasoning trace",
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
