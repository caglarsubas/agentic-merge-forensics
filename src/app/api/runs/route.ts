import { listRuns, reindexRuns } from "@/store/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  // The index is a convenience cache over the report directories; rebuilding
  // it is how a hand-deleted or hand-copied run gets picked up.
  const runs = url.searchParams.get("reindex") === "1" ? reindexRuns() : listRuns();
  return Response.json({ runs });
}
