"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CiState, ConflictState, FeedEvent, FeedView } from "@/feed/types";
import type { RemoteRepo } from "@/engine/github";

/**
 * The feed page reads a bounded snapshot the watcher already wrote to disk, so
 * painting it costs no subprocesses and no API calls. Everything expensive
 * happens in the watcher; this is a viewer.
 */

const POLL_MS = 10_000;

const KIND_LABEL: Record<FeedEvent["kind"], string> = {
  "pr-opened": "opened",
  "pr-updated": "pushed",
  "pr-merged": "merged",
  "pr-closed": "closed",
  "pr-reopened": "reopened",
  "ci-failed": "CI failed",
  "ci-recovered": "CI green",
  "conflict-appeared": "conflicted",
  "conflict-cleared": "conflict gone",
  push: "pushed to trunk",
};

/** Events that mean something is wrong get the eye; the rest stay quiet. */
const KIND_TONE: Partial<Record<FeedEvent["kind"], "good" | "warn" | "bad">> = {
  "pr-merged": "good",
  "ci-recovered": "good",
  "ci-failed": "bad",
  "conflict-appeared": "bad",
  "conflict-cleared": "good",
};

function ago(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function conflictBadge(state: ConflictState) {
  if (state === "conflicting") return <span className="badge bad">conflict</span>;
  // "unknown" is GitHub still computing mergeability. Saying "clean" there
  // would be a guess, and a wrong one often enough to matter.
  if (state === "unknown") return <span className="faint">·</span>;
  return <span className="badge good">clean</span>;
}

function ciBadge(state: CiState, failing: number) {
  if (state === "failing") {
    return <span className="badge bad">{failing > 0 ? `${failing} failing` : "failing"}</span>;
  }
  if (state === "pending") return <span className="badge warn">running</span>;
  if (state === "passing") return <span className="badge good">passing</span>;
  return <span className="faint">no checks</span>;
}

export default function Feed() {
  const [view, setView] = useState<FeedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remoteRepos, setRemoteRepos] = useState<RemoteRepo[]>([]);
  const [coderFilter, setCoderFilter] = useState<string[]>([]);
  const [repoFilter, setRepoFilter] = useState<string[]>([]);
  const [onlyTrouble, setOnlyTrouble] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(() => 0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/feed", { cache: "no-store", signal });
    if (!response.ok) throw new Error(`feed unavailable (${response.status})`);
    return (await response.json()) as FeedView;
  }, []);

  // A setTimeout chain rather than setInterval: if a poll is slow, the next one
  // starts after it finishes instead of stacking up behind it.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let loaded = false;

    async function fetchNow() {
      try {
        const next = await load(controller.signal);
        if (cancelled) return;
        loaded = true;
        setView(next);
        setError(null);
      } catch (caught) {
        if (!cancelled && (caught as Error).name !== "AbortError") {
          setError((caught as Error).message);
        }
      }
    }

    async function cycle() {
      // Polling pauses while the tab is hidden, but the FIRST load must not:
      // a page opened in a background tab would otherwise sit empty forever and
      // look like a broken feed rather than a paused one.
      if (!loaded || document.visibilityState === "visible") await fetchNow();
      if (!cancelled) timer.current = setTimeout(cycle, POLL_MS);
    }

    // Coming back to the tab should not wait out the rest of the interval.
    const onVisible = () => {
      if (document.visibilityState === "visible") void fetchNow();
    };
    document.addEventListener("visibilitychange", onVisible);

    void cycle();
    return () => {
      cancelled = true;
      controller.abort();
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  // Freshness is relative to now, so it has to re-render even when the data has
  // not changed.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void fetch("/api/repos", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { repos: RemoteRepo[] }) => setRemoteRepos(d.repos ?? []))
      .catch(() => setRemoteRepos([]));
  }, []);

  const now = Date.now();
  void tick;

  async function mutateWatchlist(method: "POST" | "DELETE", slug: string) {
    if (!slug) return;
    setBusy(true);
    try {
      const response = await fetch("/api/feed/watchlist", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `request failed (${response.status})`);
      }
      setView(await load());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const watched = view?.watchlist ?? [];
  const events = useMemo(() => view?.events ?? [], [view]);

  const coders = useMemo(
    () => [...new Set(events.map((event) => event.coder))].sort(),
    [events],
  );

  const shown = useMemo(
    () =>
      events.filter((event) => {
        if (coderFilter.length && !coderFilter.includes(event.coder)) return false;
        if (repoFilter.length && !repoFilter.includes(event.repo)) return false;
        if (onlyTrouble && event.conflict !== "conflicting" && event.ci !== "failing") {
          return false;
        }
        return true;
      }),
    [events, coderFilter, repoFilter, onlyTrouble],
  );

  function toggle(list: string[], set: (next: string[]) => void, value: string) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  const status = view?.status ?? null;
  const watcher = view?.watcher ?? null;

  return (
    <div className="wrap">
      <div className="eyebrow">agentic merge forensics</div>
      <h1>Activity</h1>
      <p className="sub">
        What the agents have been doing across the repos you watch — as it arrives, with
        conflicts and CI called out. <Link href="/">Back to analysis</Link>
      </p>

      <div className="card">
        <h2>Watching {watched.length > 0 && <span className="faint">— {watched.length}</span>}</h2>
        <div className="field">
          <select
            value=""
            disabled={busy || remoteRepos.length === 0}
            onChange={(event) => void mutateWatchlist("POST", event.target.value)}
          >
            <option value="">
              {remoteRepos.length > 0 ? "Watch a repository…" : "No repositories available"}
            </option>
            {remoteRepos
              .filter((repo) => !watched.some((entry) => entry.slug === repo.slug))
              .map((repo) => (
                <option key={repo.slug} value={repo.slug}>
                  {repo.slug}
                  {repo.isPrivate ? " · private" : ""}
                </option>
              ))}
          </select>
        </div>
        {watched.length === 0 ? (
          <p className="small">
            Nothing watched yet. Add a repository above and the watcher picks it up on its
            next cycle.
          </p>
        ) : (
          <div className="chips" style={{ marginTop: 10 }}>
            {watched.map((entry) => (
              <button
                type="button"
                key={entry.slug}
                className="chip"
                disabled={busy}
                title="Stop watching"
                onClick={() => void mutateWatchlist("DELETE", entry.slug)}
              >
                {entry.slug} ×
              </button>
            ))}
          </div>
        )}

        <p className="small" style={{ marginTop: 12 }}>
          {watcher ? (
            <>
              Watcher live — last beat {ago(watcher.heartbeatAt, now)}.
            </>
          ) : (
            <>
              No watcher running. Start one with{" "}
              <code>docker compose up -d watcher</code> and the feed keeps itself current.
            </>
          )}
          {status && (
            <>
              {" "}
              Last cycle polled {status.polled.length}, skipped {status.skipped} unchanged
              {status.deferred > 0 ? `, deferred ${status.deferred} to next cycle` : ""} in{" "}
              {(status.durationMs / 1000).toFixed(1)}s.
              {status.throttled && " Throttled to stay inside the API budget."}
              {status.errors.length > 0 && ` ${status.errors.length} repo(s) errored.`}
            </>
          )}
        </p>
        {error && <div className="err">{error}</div>}
      </div>

      <div className="card">
        <h2>Recent</h2>

        {coders.length > 0 && (
          <div className="field">
            <label>Coder {coderFilter.length === 0 && <span className="faint">— all</span>}</label>
            <div className="chips">
              {coders.map((coder) => (
                <button
                  type="button"
                  key={coder}
                  className={`chip ${coderFilter.includes(coder) ? "on" : ""}`}
                  onClick={() => toggle(coderFilter, setCoderFilter, coder)}
                >
                  {coder}
                </button>
              ))}
            </div>
          </div>
        )}

        {watched.length > 1 && (
          <div className="field" style={{ marginTop: 12 }}>
            <label>Repo {repoFilter.length === 0 && <span className="faint">— all</span>}</label>
            <div className="chips">
              {watched.map((entry) => (
                <button
                  type="button"
                  key={entry.slug}
                  className={`chip ${repoFilter.includes(entry.slug) ? "on" : ""}`}
                  onClick={() => toggle(repoFilter, setRepoFilter, entry.slug)}
                >
                  {entry.slug.split("/")[1]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="chips" style={{ marginTop: 12 }}>
          <button
            type="button"
            className={`chip ${onlyTrouble ? "on" : ""}`}
            onClick={() => setOnlyTrouble((v) => !v)}
          >
            only conflicts &amp; failing CI
          </button>
        </div>

        {shown.length === 0 ? (
          <p className="small" style={{ marginTop: 14 }}>
            {events.length === 0
              ? "No activity recorded yet."
              : "Nothing matches those filters."}
          </p>
        ) : (
          <table style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th>arrived</th>
                <th>repo</th>
                <th>what</th>
                <th>coder</th>
                <th />
                <th>conflict</th>
                <th>CI</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((event) => (
                <tr key={event.id}>
                  <td className="mono" title={`happened ${event.at} · seen ${event.observedAt}`}>
                    {ago(event.observedAt, now)}
                  </td>
                  <td className="mono">{event.repo.split("/")[1]}</td>
                  <td>
                    {KIND_TONE[event.kind] ? (
                      <span className={`badge ${KIND_TONE[event.kind]}`}>
                        {KIND_LABEL[event.kind]}
                      </span>
                    ) : (
                      <span className="faint">{KIND_LABEL[event.kind]}</span>
                    )}{" "}
                    <a href={event.url} target="_blank" rel="noreferrer">
                      {event.number !== null ? `#${event.number}` : event.title.slice(0, 40)}
                    </a>{" "}
                    <span className="faint">{event.number !== null ? event.title : ""}</span>
                  </td>
                  <td>
                    {event.coder}
                    {event.coderSource === "fallback" && (
                      <span className="faint" title="No agent signal; this is the author login">
                        {" "}
                        ?
                      </span>
                    )}
                  </td>
                  <td className="small faint">{event.detail}</td>
                  <td>{conflictBadge(event.conflict)}</td>
                  <td>{ciBadge(event.ci, event.ciFailing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
