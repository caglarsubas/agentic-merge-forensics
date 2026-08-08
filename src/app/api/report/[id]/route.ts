import { readRunHtml } from "@/store/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serve a stored report. Ids come from the run index, never from a path. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const html = readRunHtml(id);
  if (html === null) {
    return new Response("report not found", { status: 404 });
  }
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
