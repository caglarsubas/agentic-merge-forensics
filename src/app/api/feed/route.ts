import { watcherStatus } from "@/feed/supervisor";
import type { FeedView } from "@/feed/types";
import {
  FEED_INDEX_LIMIT,
  readCycleStatus,
  readFeedIndex,
  readRecentEvents,
  readWatchlist,
} from "@/store/feed-store";

export const runtime = "nodejs";
/** Reads state the watcher writes, so it must never be cached or prerendered. */
export const dynamic = "force-dynamic";

/** Default poll interval, used only to judge whether a lock is stale. */
const ASSUMED_INTERVAL_MS = Number(process.env.MERGE_FORENSICS_FEED_INTERVAL ?? 60) * 1000;

export async function GET() {
  const index = readFeedIndex();
  const holder = watcherStatus(ASSUMED_INTERVAL_MS);

  const view: FeedView = {
    // Falling back to the log means the page still works before the watcher has
    // ever written an index — the events are the source of truth, the index is
    // only a bounded cache of them.
    events: index?.events ?? readRecentEvents(FEED_INDEX_LIMIT),
    prs: index?.prs ?? [],
    updatedAt: index?.updatedAt ?? "",
    watchlist: readWatchlist(),
    status: readCycleStatus(),
    watcher: holder
      ? { pid: holder.pid, startedAt: holder.startedAt, heartbeatAt: holder.heartbeatAt }
      : null,
  };

  return Response.json(view, { headers: { "cache-control": "no-store" } });
}
