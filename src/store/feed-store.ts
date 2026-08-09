/**
 * Where the feed keeps what it has seen.
 *
 * Two storage shapes, because the feed holds two different kinds of state. The
 * watchlist, the watermarks, the index and the cycle status are small, bounded
 * and rewritten whole whenever they change, so they are plain JSON. Events are
 * none of those things: they only accumulate, and a history that gets rewritten
 * in full on every poll is one crash away from being lost entirely. So events
 * are append-only NDJSON, sharded one file per month, and the index the page
 * reads is a bounded snapshot derived from them rather than the record itself.
 *
 * Sharding costs something in return: a month boundary splits a single poll's
 * events across two files. That is the price of never rewriting a line that has
 * already landed, and it is worth paying.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, stateDir } from "../engine/paths";
import type {
  CycleStatus,
  FeedEvent,
  FeedIndex,
  RepoWatermark,
  WatchEntry,
} from "../feed/types";
import { readJson, writeJson } from "./json";

/**
 * How many events the page-facing snapshot carries. Exported so whoever builds
 * the index can stop early rather than assembling ten thousand events for this
 * function to throw away.
 */
export const FEED_INDEX_LIMIT = 500;

const SHARD = /^events-(\d{4}-\d{2})\.ndjson$/;
const MONTH = /^(\d{4}-\d{2})/;

function feedDir(): string {
  return join(stateDir(), "feed");
}

function ensureFeedDir(): string {
  return ensureDir(feedDir());
}

function watchlistPath(): string {
  return join(feedDir(), "watchlist.json");
}

function watermarksPath(): string {
  return join(feedDir(), "watermarks.json");
}

function indexPath(): string {
  return join(feedDir(), "index.json");
}

function statusPath(): string {
  return join(feedDir(), "status.json");
}

/** GitHub treats `Owner/Repo` and `owner/repo` as one repo; so does the feed. */
function sameSlug(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function readWatchlist(): WatchEntry[] {
  return readJson<WatchEntry[]>(watchlistPath(), []);
}

function writeWatchlist(entries: WatchEntry[]): WatchEntry[] {
  ensureFeedDir();
  writeJson(watchlistPath(), entries);
  return entries;
}

/** Adding a repo already on the list is a no-op, not a second entry: a
 * duplicate would poll the repo twice and emit every event twice with it. */
export function addWatch(slug: string, now: Date = new Date()): WatchEntry[] {
  // Stored lower-case, not just compared that way. The planner looks the slug
  // up in a map keyed by GitHub's own canonical casing, and a watchlist entry
  // typed as `Owner/Repo` would never match it — the repo would still be swept
  // eventually, so it would look slow rather than broken, which is worse.
  const wanted = slug.trim().toLowerCase();
  const entries = readWatchlist();
  if (entries.some((entry) => sameSlug(entry.slug, wanted))) return entries;
  return writeWatchlist([...entries, { slug: wanted, addedAt: now.toISOString() }]);
}

export function removeWatch(slug: string): WatchEntry[] {
  const entries = readWatchlist();
  const next = entries.filter((entry) => !sameSlug(entry.slug, slug));
  // Removing something that was never there is a request that has already been
  // satisfied, so it does not touch the file and does not raise.
  if (next.length === entries.length) return entries;
  return writeWatchlist(next);
}

export function setWatchPaused(slug: string, paused: boolean): WatchEntry[] {
  const entries = readWatchlist();
  let changed = false;
  const next = entries.map((entry) => {
    if (!sameSlug(entry.slug, slug) || Boolean(entry.paused) === paused) return entry;
    changed = true;
    return { ...entry, paused };
  });
  if (!changed) return entries;
  return writeWatchlist(next);
}

export function readRepoWatermarks(): Record<string, RepoWatermark> {
  return readJson<Record<string, RepoWatermark>>(watermarksPath(), {});
}

export function writeRepoWatermark(mark: RepoWatermark): void {
  ensureFeedDir();
  const all = readRepoWatermarks();
  all[mark.slug] = mark;
  writeJson(watermarksPath(), all);
}

/**
 * Shard on `at`, not `observedAt`. A shard then holds exactly the events of one
 * event-month, which is what lets `readRecentEvents` stop after the newest few
 * files instead of proving it by reading everything. An event whose `at` is
 * unusable lands in a shard that sorts last, so junk sinks to the bottom of the
 * feed rather than pinning itself to the top.
 */
function monthOf(event: FeedEvent): string {
  const match = MONTH.exec(event.at) ?? MONTH.exec(event.observedAt);
  return match ? match[1] : "0000-00";
}

export function appendEvents(events: readonly FeedEvent[]): void {
  if (events.length === 0) return;
  const dir = ensureFeedDir();

  const byMonth = new Map<string, string[]>();
  for (const event of events) {
    const month = monthOf(event);
    const lines = byMonth.get(month) ?? [];
    lines.push(JSON.stringify(event));
    byMonth.set(month, lines);
  }

  // One append per shard rather than per event: each call is a syscall, and a
  // busy cycle produces dozens of events for the same month.
  for (const [month, lines] of byMonth) {
    appendFileSync(join(dir, `events-${month}.ndjson`), `${lines.join("\n")}\n`, "utf8");
  }
}

/** Newest first. Ids break ties so two events sharing a timestamp — a PR that
 * conflicts and fails CI on the same update — keep a stable order between
 * reads. */
function byNewest(a: FeedEvent, b: FeedEvent): number {
  return b.at.localeCompare(a.at) || a.id.localeCompare(b.id);
}

function readShard(path: string): FeedEvent[] {
  const events: FeedEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as FeedEvent);
    } catch {
      // A crash between the write and its newline leaves a partial last line.
      // Losing that one event beats making the whole history unreadable.
    }
  }
  return events;
}

/** Shard names sorted newest month first; `YYYY-MM` sorts correctly as text. */
function shardNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => SHARD.test(name))
    .sort((a, b) => b.localeCompare(a));
}

export function readRecentEvents(limit: number): FeedEvent[] {
  if (limit <= 0) return [];
  const dir = feedDir();
  const collected: FeedEvent[] = [];
  for (const name of shardNames(dir)) {
    collected.push(...readShard(join(dir, name)));
    // Shards partition the history by event month, so once the newest ones have
    // filled the limit nothing in an older file can outrank what we already
    // hold. The rest of the archive stays on disk, however long it gets.
    if (collected.length >= limit) break;
  }
  return collected.sort(byNewest).slice(0, limit);
}

export function readFeedIndex(): FeedIndex | null {
  return readJson<FeedIndex | null>(indexPath(), null);
}

export function writeFeedIndex(index: FeedIndex): void {
  ensureFeedDir();
  // The caller owns the order; the cap only keeps the file small enough that
  // the page can read it whole on every request.
  writeJson(indexPath(), { ...index, events: index.events.slice(0, FEED_INDEX_LIMIT) });
}

export function readCycleStatus(): CycleStatus | null {
  return readJson<CycleStatus | null>(statusPath(), null);
}

export function writeCycleStatus(status: CycleStatus): void {
  ensureFeedDir();
  writeJson(statusPath(), status);
}
