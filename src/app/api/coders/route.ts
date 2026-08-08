import { knownCoders } from "@/engine/coder";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ coders: knownCoders() });
}
