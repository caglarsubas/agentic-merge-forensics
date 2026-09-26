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
  conflictingNow: string[];
  failingCiNow: string[];
  byCoder: Array<[string, number]>;
  repos: string[];
  filtersApplied: string[];
}

export interface SummaryResult {
  summary: string;
  facts: SummaryFacts;
  /** Stable over identical facts, so a poll that changed nothing can reuse it. */
  fingerprint: string;
  model: string;
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
  "Lead with whatever needs a human decision — a conflict, failing checks, one agent",
  "rewriting another's work. If nothing needs attention, say so plainly and briefly.",
  "",
  "Use ONLY the facts in the data. Never invent a repository name, a pull request",
  "number or a count. If a list is empty, it means none, not unknown.",
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

  const counts = new Map<string, number>();
  for (const event of inWindow) counts.set(event.coder, (counts.get(event.coder) ?? 0) + 1);

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
    conflictingNow: open
      .filter((pr) => scoped(pr) && pr.conflict === "conflicting")
      .map((pr) => `${pr.repo}#${pr.number} by ${pr.coder}`),
    failingCiNow: open
      .filter((pr) => scoped(pr) && pr.ci === "failing")
      .map((pr) => `${pr.repo}#${pr.number} by ${pr.coder} (${pr.ciFailing} failing)`),
    byCoder: [...counts].sort((a, b) => b[1] - a[1]),
    repos: [...new Set(inWindow.map((event) => event.repo))],
    filtersApplied,
  };
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
    model: process.env.MERGE_FORENSICS_LLM_MODEL ?? "gemma4:26b",
    apiKey: process.env.MERGE_FORENSICS_LLM_KEY ?? null,
    timeoutMs: Number(process.env.MERGE_FORENSICS_LLM_TIMEOUT_MS ?? 45_000),
  };
}

/**
 * gemma4 is a reasoning model, and the two paths differ in what they can do
 * about that.
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
export async function writeSummary(
  facts: SummaryFacts,
  config: LlmConfig = llmConfig(),
): Promise<string> {
  const user = `Summarise this activity:\n${JSON.stringify(facts, null, 1)}`;
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
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
        }
      : {
          model: config.model,
          stream: false,
          temperature: 0.2,
          max_tokens: 4000,
          reasoning_effort: "none",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
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
