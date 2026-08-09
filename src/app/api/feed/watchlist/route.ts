import { parseRepoRef, repoSlug } from "@/engine/types";
import { addWatch, readWatchlist, removeWatch } from "@/store/feed-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Accepts a slug or a GitHub URL, and rejects anything else with a message the
 *  page can show — parseRepoRef throws rather than returning null. */
function slugFrom(body: unknown): string {
  const raw = (body as { slug?: unknown })?.slug;
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("slug is required");
  return repoSlug(parseRepoRef(raw));
}

export async function GET() {
  return Response.json({ watchlist: readWatchlist() }, {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  try {
    const slug = slugFrom(await request.json());
    return Response.json({ watchlist: addWatch(slug) });
  } catch (caught) {
    return Response.json({ error: (caught as Error).message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const slug = slugFrom(await request.json());
    return Response.json({ watchlist: removeWatch(slug) });
  } catch (caught) {
    return Response.json({ error: (caught as Error).message }, { status: 400 });
  }
}
