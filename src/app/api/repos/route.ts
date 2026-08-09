import { listAccessibleRepos } from "@/engine/github";

export const runtime = "nodejs";
/** Hits the GitHub API through `gh`, so it must not be prerendered or cached. */
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await listAccessibleRepos();
  return Response.json(result, {
    headers: { "cache-control": "no-store" },
  });
}
