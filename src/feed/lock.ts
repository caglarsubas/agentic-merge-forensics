/**
 * Single-writer lock for the poller.
 *
 * Nothing else in this tool locks, because nothing else writes on a timer: a
 * run is something a person starts. The poller is different — it writes every
 * cycle, forever, and `docker compose up` starts the web service and the
 * watcher service from the same image against the same volume. Two watchers
 * polling the same repos would double the API spend and race on the event log.
 *
 * The lock is advisory and deliberately crude: an O_EXCL create, a heartbeat,
 * and a staleness window so a killed process cannot park the feed permanently.
 * A loser does not crash — it serves the feed read-only and says so, because a
 * silent second process looks exactly like a broken first one.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ensureDir, stateDir } from "../engine/paths";

export interface LockHolder {
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface AcquireResult {
  acquired: boolean;
  holder: LockHolder | null;
  /** Set when we took the lock from a process that stopped heartbeating. */
  stolenFrom: LockHolder | null;
}

function lockPath(): string {
  return join(ensureDir(join(stateDir(), "feed")), "watcher.lock");
}

export function readLock(): LockHolder | null {
  const path = lockPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockHolder;
  } catch {
    // A half-written lock is worth no more than no lock at all.
    return null;
  }
}

/** A holder that has not heartbeated in this long is presumed dead. */
export function isStale(holder: LockHolder, staleAfterMs: number, now: Date): boolean {
  const beat = Date.parse(holder.heartbeatAt);
  if (Number.isNaN(beat)) return true;
  return now.getTime() - beat > staleAfterMs;
}

export function acquire(staleAfterMs: number, now: Date = new Date()): AcquireResult {
  const path = lockPath();
  const stamp = now.toISOString();
  const mine: LockHolder = {
    pid: process.pid,
    host: hostname(),
    startedAt: stamp,
    heartbeatAt: stamp,
  };

  try {
    // wx is the whole point: create-or-fail is atomic, so two processes racing
    // here cannot both believe they won.
    writeFileSync(path, `${JSON.stringify(mine, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { acquired: true, holder: mine, stolenFrom: null };
  } catch {
    const existing = readLock();
    if (existing && !isStale(existing, staleAfterMs, now)) {
      return { acquired: false, holder: existing, stolenFrom: null };
    }
    // Either unreadable or long dead. Take it: a watcher that refuses to start
    // because of a lock left by a `docker kill` would need manual repair.
    writeFileSync(path, `${JSON.stringify(mine, null, 2)}\n`, "utf8");
    return { acquired: true, holder: mine, stolenFrom: existing };
  }
}

export function heartbeat(now: Date = new Date()): void {
  const existing = readLock();
  if (!existing || existing.pid !== process.pid) return;
  writeFileSync(
    lockPath(),
    `${JSON.stringify({ ...existing, heartbeatAt: now.toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

export function release(): void {
  const existing = readLock();
  if (!existing || existing.pid !== process.pid) return;
  try {
    unlinkSync(lockPath());
  } catch {
    // Losing the release just means the next start waits out the stale window.
  }
}
