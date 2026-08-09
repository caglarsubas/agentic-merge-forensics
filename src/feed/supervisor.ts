/**
 * The loop that makes "always follows" literally true.
 *
 * Kept separate from the cycle so the interesting part stays testable and this
 * part stays boring: acquire the lock, run a cycle, sleep, repeat. The one rule
 * it enforces is that a cycle failing must never end the loop — a watcher that
 * exits on a transient network error is worse than no watcher, because the feed
 * silently stops updating while the page still looks alive.
 */
import { acquire, heartbeat, readLock, release } from "./lock";
import { runCycle } from "./poller";

export interface WatchOptions {
  intervalMs: number;
  /** Mostly for tests and `--once`: stop after this many cycles. */
  maxCycles?: number;
  log?: (message: string) => void;
}

/** A lock whose holder has not beaten in three intervals is presumed dead. */
function staleAfter(intervalMs: number): number {
  return Math.max(3 * intervalMs, 90_000);
}

/**
 * Sleep, but wake early on shutdown. The timers are deliberately NOT unref'd:
 * between cycles they are the only thing keeping the event loop alive, and an
 * unref'd wait means the process exits the moment it goes idle — which under
 * `restart: unless-stopped` looks exactly like a crash loop.
 */
function sleep(ms: number, signal: { aborted: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const poll = setInterval(() => {
      if (signal.aborted) done();
    }, 250);
  });
}

export async function watch(options: WatchOptions): Promise<void> {
  const log = options.log ?? ((message: string) => console.log(message));
  const signal = { aborted: false };

  const stop = () => {
    signal.aborted = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  // Wait for the lock rather than exiting without it. Under a process
  // supervisor, exiting is not "stepping aside" — it is a restart loop, and the
  // lock left behind by a killed container is exactly the case that triggers
  // it. Waiting means the survivor takes over on its own once the dead holder's
  // heartbeat goes stale.
  const stale = staleAfter(options.intervalMs);
  const retryMs = Math.min(options.intervalMs, 15_000);
  let waited = false;
  for (;;) {
    if (signal.aborted) {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      return;
    }
    const lock = acquire(stale);
    if (lock.acquired) {
      if (lock.stolenFrom) {
        log(
          `took over a stale lock from pid ${lock.stolenFrom.pid} (last beat ${lock.stolenFrom.heartbeatAt})`,
        );
      }
      break;
    }
    if (!waited) {
      const holder = lock.holder;
      log(
        `another watcher holds the lock (pid ${holder?.pid} on ${holder?.host}). ` +
          `Waiting rather than polling the same repos twice.`,
      );
      waited = true;
    }
    await sleep(retryMs, signal);
  }

  log(`watching every ${Math.round(options.intervalMs / 1000)}s — ctrl-c to stop`);

  let cycles = 0;
  try {
    for (;;) {
      try {
        const status = await runCycle();
        const detail =
          status.polled.length === 0
            ? "nothing changed"
            : `${status.polled.length} repo(s), ${status.newEvents} new event(s)`;
        log(
          `cycle ${status.cycle}: ${detail}` +
            (status.deferred > 0 ? `, ${status.deferred} deferred` : "") +
            (status.throttled ? ", throttled" : "") +
            (status.errors.length > 0 ? `, ${status.errors.length} error(s)` : "") +
            ` (${(status.durationMs / 1000).toFixed(1)}s)`,
        );
      } catch (caught) {
        // Deliberately swallowed. See the file header.
        log(`cycle failed: ${(caught as Error).message}`);
      }

      cycles += 1;
      if (options.maxCycles && cycles >= options.maxCycles) return;
      if (signal.aborted) return;

      heartbeat();
      await sleep(options.intervalMs, signal);
      if (signal.aborted) return;
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    release();
    log("watcher stopped");
  }
}

/** Who, if anyone, is polling right now. */
export function watcherStatus(intervalMs: number, now: Date = new Date()) {
  const holder = readLock();
  if (!holder) return null;
  const beat = Date.parse(holder.heartbeatAt);
  if (!Number.isNaN(beat) && now.getTime() - beat > staleAfter(intervalMs)) return null;
  return holder;
}
