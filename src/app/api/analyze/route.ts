/**
 * Start an analysis and stream progress back.
 *
 * A full-depth run takes tens of seconds — it clones, blames and replays
 * merges — so this streams newline-delimited JSON rather than leaving the
 * browser on a blank spinner with no idea whether anything is happening.
 */
import { analyze } from "@/engine/analyze";
import { renderReportHtml } from "@/report/html";
import { saveRun } from "@/store/store";
import { parseRepoRef } from "@/engine/types";

export const runtime = "nodejs";
// The engine shells out to git and reads the clone cache; nothing here is
// cacheable and a stale response would silently show an old run.
export const dynamic = "force-dynamic";

interface AnalyzeBody {
  repos?: string[];
  count?: number;
  since?: string;
  coders?: string[] | null;
  offline?: boolean;
}

export async function POST(request: Request) {
  let body: AnalyzeBody;
  try {
    body = (await request.json()) as AnalyzeBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const repoInputs = (body.repos ?? []).map((repo) => repo.trim()).filter(Boolean);
  if (repoInputs.length === 0) {
    return Response.json({ error: "at least one repository is required" }, { status: 400 });
  }

  let repos;
  try {
    repos = repoInputs.map(parseRepoRef);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  if (body.count !== undefined && body.since) {
    return Response.json(
      { error: "choose either a PR count or a time window, not both" },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        const report = await analyze({
          repos,
          count: body.since ? undefined : (body.count ?? 50),
          since: body.since ? new Date(body.since) : undefined,
          coders: body.coders?.length ? body.coders : null,
          offline: body.offline,
          onProgress: (message) => send({ type: "progress", message }),
        });
        const saved = saveRun(report, renderReportHtml(report));
        send({ type: "done", summary: saved.summary });
      } catch (error) {
        send({ type: "error", message: (error as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
