import {
  extractFacts,
  fingerprint,
  llmConfig,
  writeSummary,
  type SummaryFilter,
  type SummaryResult,
} from "@/feed/summary";
import { readFeedIndex, readRecentEvents, FEED_INDEX_LIMIT } from "@/store/feed-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cached on the facts, not on the request.
 *
 * The dashboard re-polls every ten seconds, and a filter change should produce
 * a fresh summary — but re-running a 26B model every ten seconds to describe
 * data that has not moved would be pure waste and would queue requests behind
 * each other. Keying the cache on a hash of the derived facts gets both: any
 * real change (new event, different window, different filter) misses the cache
 * and re-infers, while a poll that changed nothing is free.
 */
const cache = new Map<string, { result: SummaryResult; at: number }>();
const CACHE_MAX = 50;
const CACHE_TTL_MS = 30 * 60_000;

function remember(key: string, result: SummaryResult): void {
  cache.set(key, { result, at: Date.now() });
  if (cache.size > CACHE_MAX) {
    // Oldest-first eviction; Map preserves insertion order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export async function POST(request: Request) {
  let filter: SummaryFilter;
  try {
    const body = (await request.json()) as Partial<SummaryFilter>;
    if (typeof body.from !== "number" || typeof body.to !== "number") {
      throw new Error("from and to are required epoch milliseconds");
    }
    filter = {
      from: body.from,
      to: body.to,
      windowLabel: typeof body.windowLabel === "string" ? body.windowLabel : "the selected window",
      coders: Array.isArray(body.coders) ? body.coders : [],
      repos: Array.isArray(body.repos) ? body.repos : [],
      onlyConflicting: Boolean(body.onlyConflicting),
      onlyFailing: Boolean(body.onlyFailing),
    };
  } catch (caught) {
    return Response.json({ error: (caught as Error).message }, { status: 400 });
  }

  const index = readFeedIndex();
  const events = index?.events ?? readRecentEvents(FEED_INDEX_LIMIT);
  const facts = extractFacts(events, index?.prs ?? [], filter);
  const config = llmConfig();
  const key = fingerprint(facts, config.model);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Response.json({ ...hit.result, cached: true } satisfies SummaryResult, {
      headers: { "cache-control": "no-store" },
    });
  }

  // Nothing to describe. Saying so costs nothing and avoids a model call that
  // would have to invent something to fill the silence.
  if (facts.events === 0 && facts.openPrs === 0) {
    const empty: SummaryResult = {
      summary: "Nothing recorded in this window.",
      facts,
      fingerprint: key,
      model: config.model,
      source: "template",
      attempts: 0,
      cached: false,
      elapsedMs: 0,
    };
    remember(key, empty);
    return Response.json(empty, { headers: { "cache-control": "no-store" } });
  }

  const started = Date.now();
  try {
    const written = await writeSummary(facts, config);
    // Worth seeing in the logs: which claims the model keeps getting wrong.
    written.rejected.forEach((problems, i) =>
      console.warn(`summary ${key}: draft ${i + 1} rejected — ${problems.join("; ")}`),
    );
    const result: SummaryResult = {
      summary: written.text,
      facts,
      fingerprint: key,
      model: config.model,
      source: written.source,
      attempts: written.attempts,
      cached: false,
      elapsedMs: Date.now() - started,
    };
    remember(key, result);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (caught) {
    // The dashboard is useful without a summary, so a model that is down or
    // slow degrades this one panel rather than the page.
    return Response.json(
      {
        error: (caught as Error).message,
        facts,
        model: config.model,
        endpoint: `${config.baseUrl} (${config.flavour})`,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
