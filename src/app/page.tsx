"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CiState, ConflictState, FeedEvent, FeedView, PrSnapshot } from "@/feed/types";
import type { RemoteRepo } from "@/engine/github";

/**
 * The dashboard reads a bounded snapshot the watcher already wrote to disk, so
 * painting it costs no subprocesses and no API calls. Everything expensive
 * happens in the watcher; this is a viewer.
 *
 * It answers "what is true right now" from the PR snapshot and "what has been
 * happening" from the event log. Those are different questions and the page
 * keeps them apart: the tiles and the repo table are current state, so the time
 * window does not apply to them; the histogram, the agent bars and the stream
 * are history, so it does.
 */

const POLL_MS = 10_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface TimeWindow {
  key: string;
  label: string;
  ms: number;
  /** How many bars the histogram splits the window into. */
  buckets: number;
  /** What one bar covers, named for the axis note. */
  unit: string;
}

/**
 * Bucket counts are chosen so a bar is always a period a person can name — five
 * minutes, an hour, a day, a week — rather than an arbitrary slice of the
 * window.
 */
const WINDOWS: TimeWindow[] = [
  { key: "1h", label: "1h", ms: HOUR, buckets: 12, unit: "5 minutes" },
  { key: "24h", label: "24h", ms: DAY, buckets: 24, unit: "hour" },
  { key: "1w", label: "1w", ms: 7 * DAY, buckets: 7, unit: "day" },
  { key: "30d", label: "30d", ms: 30 * DAY, buckets: 30, unit: "day" },
  { key: "60d", label: "60d", ms: 60 * DAY, buckets: 30, unit: "2 days" },
  { key: "3m", label: "3m", ms: 91 * DAY, buckets: 13, unit: "week" },
  { key: "6m", label: "6m", ms: 182 * DAY, buckets: 26, unit: "week" },
  { key: "9m", label: "9m", ms: 273 * DAY, buckets: 39, unit: "week" },
  { key: "1y", label: "1y", ms: 365 * DAY, buckets: 12, unit: "month" },
  { key: "5y", label: "5y", ms: 5 * 365 * DAY, buckets: 20, unit: "quarter" },
];

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

const KIND_TONE: Partial<Record<FeedEvent["kind"], "good" | "warn" | "bad">> = {
  "pr-merged": "good",
  "ci-recovered": "good",
  "ci-failed": "bad",
  "conflict-appeared": "bad",
  "conflict-cleared": "good",
};

/**
 * Identity colour is assigned from the coder's position in the rule list, not
 * from how busy it is — so filtering the view never repaints the survivors.
 * Past the fourth agent the colour is dropped rather than invented: the label
 * beside it is what actually carries identity, and a generated fifth hue would
 * not survive a colour-vision check.
 */
function coderColor(coder: string, canonical: string[]): string | null {
  const index = canonical.indexOf(coder);
  if (index < 0 || index > 3) return null;
  return `var(--c${index + 1})`;
}

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

/** A bucket's span, named at the precision the window actually distinguishes. */
function bucketLabel(from: number, to: number, windowMs: number): string {
  const start = new Date(from);
  const end = new Date(to);
  if (windowMs <= DAY) {
    const time = (d: Date) =>
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${time(start)} – ${time(end)}`;
  }
  const day = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return day(start) === day(end) ? day(start) : `${day(start)} – ${day(end)}`;
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

export default function Activity() {
  const [view, setView] = useState<FeedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remoteRepos, setRemoteRepos] = useState<RemoteRepo[]>([]);
  const [canonicalCoders, setCanonicalCoders] = useState<string[]>([]);

  const [windowKey, setWindowKey] = useState("24h");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [coderFilter, setCoderFilter] = useState<string[]>([]);
  const [repoFilter, setRepoFilter] = useState<string[]>([]);
  const [onlyConflicting, setOnlyConflicting] = useState(false);
  const [onlyFailing, setOnlyFailing] = useState(false);

  /**
   * An exact span from clicking a bar. Kept apart from the custom date inputs
   * because those are day-granular: rounding an hourly bar to its date would
   * "zoom" from four events to the whole day's twenty-five, which is the
   * opposite of what the click promises.
   */
  const [zoom, setZoom] = useState<{ from: number; to: number } | null>(null);
  const [hoverBucket, setHoverBucket] = useState<number | null>(null);
  const [hoverAgent, setHoverAgent] = useState<string | null>(null);

  const [repoQuery, setRepoQuery] = useState("");
  const [comboOpen, setComboOpen] = useState(false);
  const [comboIndex, setComboIndex] = useState(0);

  const [summary, setSummary] = useState<string | null>(null);
  const [summaryMeta, setSummaryMeta] = useState<{
    ms: number;
    cached: boolean;
    model: string;
    source: "model" | "template";
    attempts: number;
  } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenIds = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/feed", { cache: "no-store", signal });
    if (!response.ok) throw new Error(`feed unavailable (${response.status})`);
    return (await response.json()) as FeedView;
  }, []);

  /** Mark what arrived since the last poll, so the eye is drawn to it once. */
  const absorb = useCallback((next: FeedView) => {
    const ids = new Set(next.events.map((event) => event.id));
    if (seenIds.current === null) {
      // First load is not "new" — everything on screen would flash at once.
      seenIds.current = ids;
      setFreshIds(new Set());
    } else {
      const previous = seenIds.current;
      const arrived = new Set([...ids].filter((id) => !previous.has(id)));
      seenIds.current = ids;
      if (arrived.size > 0) setFreshIds(arrived);
    }
    setView(next);
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
        absorb(next);
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
  }, [load, absorb]);

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
    void fetch("/api/coders")
      .then((r) => r.json())
      .then((d: { coders: string[] }) => setCanonicalCoders(d.coders ?? []))
      .catch(() => setCanonicalCoders([]));
  }, []);

  const now = Date.now();

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
      absorb(await load());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const watched = useMemo(() => view?.watchlist ?? [], [view]);
  const events = useMemo(() => view?.events ?? [], [view]);
  const prs = useMemo(() => view?.prs ?? [], [view]);

  /** Current state — deliberately not windowed. "Conflicting" means now. */
  const openPrs = useMemo(() => prs.filter((pr) => pr.state === "open"), [prs]);
  const conflicting = useMemo(
    () => openPrs.filter((pr) => pr.conflict === "conflicting"),
    [openPrs],
  );
  const ciFailing = useMemo(() => openPrs.filter((pr) => pr.ci === "failing"), [openPrs]);

  /** The selected window, resolved to an absolute span. */
  const span = useMemo(() => {
    if (windowKey === "zoom" && zoom) {
      return { from: zoom.from, to: zoom.to, buckets: 24, unit: "slice" };
    }
    if (windowKey === "custom") {
      const from = customFrom ? Date.parse(customFrom) : NaN;
      if (Number.isNaN(from)) return null;
      // An end date means the whole of that day, not midnight at its start.
      const parsedTo = customTo ? Date.parse(customTo) + DAY - 1 : now;
      return { from, to: Number.isNaN(parsedTo) ? now : parsedTo, buckets: 24, unit: "period" };
    }
    const preset = WINDOWS.find((w) => w.key === windowKey) ?? WINDOWS[1];
    return { from: now - preset.ms, to: now, buckets: preset.buckets, unit: preset.unit };
  }, [windowKey, customFrom, customTo, now, zoom]);

  /** PR facts by key, so an event can link to its branch and name its author
   *  without the event log having to carry a copy of all of it. */
  const prIndex = useMemo(() => {
    const map = new Map<string, PrSnapshot>();
    for (const pr of prs) map.set(`${pr.repo}#${pr.number}`, pr);
    return map;
  }, [prs]);

  const inWindow = useMemo(() => {
    if (!span) return [];
    return events.filter((event) => {
      const at = Date.parse(event.observedAt);
      return at >= span.from && at <= span.to;
    });
  }, [events, span]);

  const landed = inWindow.filter((event) => event.kind === "pr-merged").length;

  /** How far back the log actually goes. Anything before this is not "zero
   *  events", it is "the feed was not watching yet", and the chart says so. */
  const logStart = useMemo(() => {
    if (events.length === 0) return null;
    return Math.min(...events.map((event) => Date.parse(event.observedAt)));
  }, [events]);

  const buckets = useMemo(() => {
    if (!span) return [];
    const size = (span.to - span.from) / span.buckets;
    const out = Array.from({ length: span.buckets }, (_, index) => ({
      index,
      from: span.from + index * size,
      to: span.from + (index + 1) * size,
      total: 0,
      byCoder: new Map<string, number>(),
      /** The whole bucket predates the first thing the feed ever recorded. */
      noData: false,
    }));
    for (const event of inWindow) {
      const index = Math.min(
        span.buckets - 1,
        Math.floor((Date.parse(event.observedAt) - span.from) / size),
      );
      if (index < 0) continue;
      const bucket = out[index];
      bucket.total += 1;
      bucket.byCoder.set(event.coder, (bucket.byCoder.get(event.coder) ?? 0) + 1);
    }
    if (logStart !== null) {
      for (const bucket of out) if (bucket.to <= logStart) bucket.noData = true;
    }
    return out;
  }, [inWindow, span, logStart]);
  const busiestBucket = Math.max(1, ...buckets.map((bucket) => bucket.total));

  const agentActivity = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of inWindow) counts.set(event.coder, (counts.get(event.coder) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [inWindow]);
  const busiestAgent = Math.max(1, ...agentActivity.map(([, count]) => count));

  const repoRows = useMemo(() => {
    return watched.map((entry) => {
      const mine = (list: PrSnapshot[]) => list.filter((pr) => pr.repo === entry.slug);
      const last = events.find((event) => event.repo === entry.slug);
      return {
        slug: entry.slug,
        open: mine(openPrs).length,
        conflicting: mine(conflicting).length,
        failing: mine(ciFailing).length,
        lastAt: last?.observedAt ?? null,
      };
    });
  }, [watched, openPrs, conflicting, ciFailing, events]);

  const coders = useMemo(() => [...new Set(events.map((e) => e.coder))].sort(), [events]);

  const shown = useMemo(
    () =>
      inWindow.filter((event) => {
        if (coderFilter.length && !coderFilter.includes(event.coder)) return false;
        if (repoFilter.length && !repoFilter.includes(event.repo)) return false;
        if (onlyConflicting && event.conflict !== "conflicting") return false;
        if (onlyFailing && event.ci !== "failing") return false;
        return true;
      }),
    [inWindow, coderFilter, repoFilter, onlyConflicting, onlyFailing],
  );

  /**
   * The exact question being asked of the model, as a string.
   *
   * Everything the summary depends on lives in here, which is what lets the
   * effect below depend on this alone. The window edges are rounded to the
   * minute on purpose: a preset window slides with the clock, and without
   * rounding this would change identity every second and re-ask continuously.
   */
  const summaryRequest = useMemo(() => {
    if (!span) return null;
    const label =
      windowKey === "custom"
        ? "the selected date range"
        : windowKey === "zoom"
          ? "the zoomed period"
          : `the last ${windowKey}`;
    return JSON.stringify({
      from: Math.floor(span.from / MINUTE) * MINUTE,
      to: Math.floor(span.to / MINUTE) * MINUTE,
      windowLabel: label,
      coders: [...coderFilter].sort(),
      repos: [...repoFilter].sort(),
      onlyConflicting,
      onlyFailing,
      // Not sent to the server — only here so new events re-ask the question.
      seen: events.length > 0 ? `${events.length}:${events[0].id}` : "0",
    });
  }, [span, windowKey, coderFilter, repoFilter, onlyConflicting, onlyFailing, events]);

  useEffect(() => {
    if (!summaryRequest) return;
    const controller = new AbortController();
    // Debounced: clicking through four windows should ask once, not four times.
    const handle = setTimeout(() => {
      void (async () => {
        setSummaryLoading(true);
        try {
          const response = await fetch("/api/summary", {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: summaryRequest,
          });
          const data = (await response.json()) as {
            summary?: string;
            error?: string;
            elapsedMs?: number;
            cached?: boolean;
            model?: string;
            source?: "model" | "template";
            attempts?: number;
          };
          if (!response.ok) throw new Error(data.error ?? `summary failed (${response.status})`);
          setSummary(data.summary ?? "");
          setSummaryMeta({
            ms: data.elapsedMs ?? 0,
            cached: Boolean(data.cached),
            model: data.model ?? "",
            source: data.source ?? "model",
            attempts: data.attempts ?? 1,
          });
          setSummaryError(null);
        } catch (caught) {
          if ((caught as Error).name !== "AbortError") {
            setSummaryError((caught as Error).message);
          }
        } finally {
          setSummaryLoading(false);
        }
      })();
    }, 400);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [summaryRequest]);

  /** Repos not yet watched, narrowed by what has been typed. */
  const repoMatches = useMemo(() => {
    const query = repoQuery.trim().toLowerCase();
    const available = remoteRepos.filter(
      (repo) => !watched.some((entry) => entry.slug === repo.slug),
    );
    if (!query) return available.slice(0, 60);
    return available.filter((repo) => repo.slug.toLowerCase().includes(query)).slice(0, 60);
  }, [remoteRepos, watched, repoQuery]);

  function toggle(list: string[], set: (next: string[]) => void, value: string) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  const activeRefinements =
    coderFilter.length + repoFilter.length + (onlyConflicting ? 1 : 0) + (onlyFailing ? 1 : 0);

  function clearRefinements() {
    setCoderFilter([]);
    setRepoFilter([]);
    setOnlyConflicting(false);
    setOnlyFailing(false);
  }

  /** A window reaching further back than the log makes the count look stuck:
   *  1w and 5y return the same events because that is all there is. Saying so
   *  where the window is chosen is the difference between an honest empty
   *  region and an apparently broken filter. */
  const spanPredatesLog = span !== null && logStart !== null && span.from < logStart;

  const status = view?.status ?? null;
  const watcher = view?.watcher ?? null;
  const beatAge = watcher ? now - Date.parse(watcher.heartbeatAt) : null;
  const liveness =
    watcher === null ? "idle" : beatAge !== null && beatAge > 5 * MINUTE ? "stale" : "live";

  return (
    <div className="wrap">
      <div className="eyebrow">agentic merge forensics</div>
      <h1>Activity</h1>
      <p className="sub">
        What the agents are doing across the repos you watch — current state up top, as it
        arrives below. For conflict rates, cross-agent overwrites and churn,{" "}
        <Link href="/analysis">run a forensic analysis →</Link>
      </p>

      <p className="small" style={{ marginTop: 4 }}>
        <span className={`dot ${liveness}`} />
        {liveness === "live" && <>Watcher live — last checked {ago(watcher!.heartbeatAt, now)}.</>}
        {liveness === "stale" && (
          <>Watcher has not checked in since {ago(watcher!.heartbeatAt, now)} — it may be stuck.</>
        )}
        {liveness === "idle" && (
          <>
            No watcher running. Start one with <code>docker compose up -d watcher</code>.
          </>
        )}
        {status && (
          <>
            {" "}
            Last cycle polled {status.polled.length}, skipped {status.skipped} unchanged
            {status.deferred > 0 ? `, deferred ${status.deferred}` : ""} in{" "}
            {(status.durationMs / 1000).toFixed(1)}s.
            {status.throttled && " Throttled to stay inside the API budget."}
            {status.errors.length > 0 && ` ${status.errors.length} repo(s) errored.`}
          </>
        )}
      </p>
      {error && <div className="err">{error}</div>}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="toolbar">
          {WINDOWS.map((option) => (
            <button
              type="button"
              key={option.key}
              className={`chip ${windowKey === option.key ? "on" : ""}`}
              onClick={() => setWindowKey(option.key)}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            className={`chip ${windowKey === "custom" ? "on" : ""}`}
            onClick={() => setWindowKey("custom")}
          >
            custom
          </button>
          {windowKey === "zoom" && zoom && (
            <button
              type="button"
              className="chip on"
              title="clear the zoom"
              onClick={() => {
                setZoom(null);
                setWindowKey("24h");
              }}
            >
              zoomed: {bucketLabel(zoom.from, zoom.to, zoom.to - zoom.from)} ×
            </button>
          )}
        </div>

        {windowKey === "custom" && (
          <div className="custom">
            <label htmlFor="from" style={{ margin: 0 }}>
              from
            </label>
            <input
              id="from"
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
            />
            <label htmlFor="to" style={{ margin: 0 }}>
              to
            </label>
            <input
              id="to"
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
            />
            <span className="small faint">
              {customFrom ? "end date is inclusive; blank means now" : "pick a start date"}
            </span>
          </div>
        )}

        <details className="adv">
          <summary>
            Advanced filters
            {activeRefinements > 0 && <span className="count">{activeRefinements}</span>}
          </summary>
          <div className="advbody">
            {watched.length > 0 && (
              <div className="field">
                <label>
                  Repository {repoFilter.length === 0 && <span className="faint">— all</span>}
                </label>
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

            {coders.length > 0 && (
              <div className="field" style={{ marginTop: 12 }}>
                <label>
                  Coding platform {coderFilter.length === 0 && <span className="faint">— all</span>}
                </label>
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

            <div className="field" style={{ marginTop: 12 }}>
              <label>State</label>
              <div className="chips">
                <button
                  type="button"
                  className={`chip ${onlyConflicting ? "on" : ""}`}
                  onClick={() => setOnlyConflicting((v) => !v)}
                >
                  conflicting only
                </button>
                <button
                  type="button"
                  className={`chip ${onlyFailing ? "on" : ""}`}
                  onClick={() => setOnlyFailing((v) => !v)}
                >
                  failing CI only
                </button>
                {activeRefinements > 0 && (
                  <button type="button" className="chip" onClick={clearRefinements}>
                    clear all
                  </button>
                )}
              </div>
            </div>
          </div>
        </details>
      </div>

      <div className="card summary" style={{ marginTop: 14 }}>
        <div className="summary-head">
          <h2>What has been happening</h2>
          <span className="small faint">
            {summaryLoading
              ? "writing…"
              : summaryMeta
                ? summaryLabel(summaryMeta)
                : ""}
          </span>
        </div>
        {summaryError ? (
          <p className="small">
            No summary: {summaryError}. The numbers below are unaffected.
          </p>
        ) : (
          <p className={`body ${summary ? "" : "pending"}`}>
            {summary ?? "Reading the feed…"}
          </p>
        )}
      </div>

      <div className="tiles" style={{ marginTop: 14 }}>
        <div className="tile">
          <div className="v">{openPrs.length}</div>
          <div className="k">open pull requests</div>
        </div>
        <div className={`tile ${conflicting.length > 0 ? "bad" : ""}`}>
          <div className="v">{conflicting.length}</div>
          <div className="k">conflicting now</div>
        </div>
        <div className={`tile ${ciFailing.length > 0 ? "bad" : ""}`}>
          <div className="v">{ciFailing.length}</div>
          <div className="k">failing CI now</div>
        </div>
        <div className="tile">
          <div className="v">{landed}</div>
          <div className="k">landed in window</div>
        </div>
        <div className="tile">
          <div className="v">{agentActivity.length}</div>
          <div className="k">active in window</div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>Activity</h2>
          <p className="small">
            {inWindow.length} event{inWindow.length === 1 ? "" : "s"}
            {span ? <> · one bar per {span.unit}</> : <> · pick a start date</>}
          </p>

          <div className="chart" style={{ marginTop: 10 }}>
            <div className="hours" onMouseLeave={() => setHoverBucket(null)}>
              {buckets.map((bucket) => {
                const height = bucket.total > 0 ? (bucket.total / busiestBucket) * 100 : 0;
                return (
                  <button
                    type="button"
                    key={bucket.index}
                    className={`hour ${bucket.total > 0 ? "" : bucket.noData ? "nodata" : "zero"}`}
                    style={bucket.total > 0 ? { height: `${Math.max(6, height)}%` } : undefined}
                    onMouseEnter={() => setHoverBucket(bucket.index)}
                    onFocus={() => setHoverBucket(bucket.index)}
                    onBlur={() => setHoverBucket(null)}
                    // Clicking a bar narrows the window to what it covers, so
                    // the chart is a way into the data rather than a picture of it.
                    onClick={() => {
                      if (bucket.total === 0) return;
                      setZoom({ from: bucket.from, to: bucket.to });
                      setWindowKey("zoom");
                    }}
                    aria-label={`${bucket.total} events, ${
                      span ? bucketLabel(bucket.from, bucket.to, span.to - span.from) : ""
                    }`}
                  >
                    {[...bucket.byCoder]
                      .sort((a, b) => b[1] - a[1])
                      .map(([coder, count]) => (
                        <span
                          key={coder}
                          className="seg"
                          style={{
                            height: `${(count / bucket.total) * 100}%`,
                            background: coderColor(coder, canonicalCoders) ?? "var(--faint)",
                          }}
                        />
                      ))}
                  </button>
                );
              })}
            </div>

            {hoverBucket !== null && buckets[hoverBucket] && span && (
              <div
                className="tip"
                // Centred on the bar, but never closer to an edge than half
                // its own max width, so it cannot spill out of the card.
                // Centred on the bar, but never closer to an edge than half
                // its own width. The bounds are themselves clamped to 50% so a
                // chart narrower than the tip degrades to centred rather than
                // inverting the clamp and spilling out of the card.
                style={{
                  left: `clamp(min(110px, 50%), ${
                    ((hoverBucket + 0.5) / buckets.length) * 100
                  }%, max(calc(100% - 110px), 50%))`,
                }}
                role="status"
              >
                <div className="tip-k">
                  {bucketLabel(
                    buckets[hoverBucket].from,
                    buckets[hoverBucket].to,
                    span.to - span.from,
                  )}
                </div>
                {buckets[hoverBucket].noData ? (
                  <div>not yet recording</div>
                ) : buckets[hoverBucket].total === 0 ? (
                  <div>no events</div>
                ) : (
                  <>
                    <div>
                      <strong>{buckets[hoverBucket].total}</strong> event
                      {buckets[hoverBucket].total === 1 ? "" : "s"}
                    </div>
                    {[...buckets[hoverBucket].byCoder]
                      .sort((a, b) => b[1] - a[1])
                      .map(([coder, count]) => (
                        <div key={coder}>
                          <span
                            className="swatch"
                            style={{
                              background: coderColor(coder, canonicalCoders) ?? "var(--faint)",
                            }}
                          />
                          {coder} <span className="tip-k">{count}</span>
                        </div>
                      ))}
                  </>
                )}
              </div>
            )}
          </div>

          <p className="small faint" style={{ marginTop: 8 }}>
            oldest → newest · click a bar to zoom to it
          </p>
          {spanPredatesLog && logStart !== null && (
            <p className="small" style={{ marginTop: 4 }}>
              The feed only started recording {ago(new Date(logStart).toISOString(), now)}, so
              longer windows return the same events. The hatched bars are before that.
            </p>
          )}
        </div>

        <div className="card">
          <h2>Who is working</h2>
          {agentActivity.length === 0 ? (
            <p className="small">Nothing in this window.</p>
          ) : (
            <div className="chart" style={{ marginTop: 10 }} onMouseLeave={() => setHoverAgent(null)}>
              {agentActivity.slice(0, 6).map(([coder, count]) => {
                const color = coderColor(coder, canonicalCoders);
                const selected = coderFilter.includes(coder);
                return (
                  <button
                    type="button"
                    className={`barrow clickable ${selected ? "on" : ""}`}
                    key={coder}
                    onMouseEnter={() => setHoverAgent(coder)}
                    onFocus={() => setHoverAgent(coder)}
                    onBlur={() => setHoverAgent(null)}
                    onClick={() => toggle(coderFilter, setCoderFilter, coder)}
                    aria-pressed={selected}
                    title={`${count} of ${inWindow.length} events — click to filter`}
                  >
                    <span className="small barlabel" style={{ color: "var(--ink)" }}>
                      {coder}
                    </span>
                    <span className="bartrack">
                      <span
                        className="barfill"
                        style={{
                          width: `${(count / busiestAgent) * 100}%`,
                          background: color ?? "var(--faint)",
                        }}
                      />
                    </span>
                    <span className="small mono">
                      {hoverAgent === coder && inWindow.length > 0
                        ? `${Math.round((count / inWindow.length) * 100)}%`
                        : count}
                    </span>
                  </button>
                );
              })}
              <p className="small faint" style={{ marginTop: 8 }}>
                click to filter · colours match the bars on the left
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h2>
          Repositories {watched.length > 0 && <span className="faint">— {watched.length}</span>}
        </h2>
        <div className="field combo">
          <input
            type="text"
            role="combobox"
            aria-expanded={comboOpen}
            aria-controls="repo-matches"
            aria-autocomplete="list"
            placeholder={
              remoteRepos.length > 0
                ? `Search ${remoteRepos.length} repositories…`
                : "No repositories available"
            }
            value={repoQuery}
            disabled={busy || remoteRepos.length === 0}
            onChange={(event) => {
              setRepoQuery(event.target.value);
              setComboOpen(true);
              setComboIndex(0);
            }}
            onFocus={() => setComboOpen(true)}
            // A blur that fires before the click would cancel the selection,
            // so closing waits a tick for the mousedown to land.
            onBlur={() => setTimeout(() => setComboOpen(false), 120)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setComboOpen(true);
                setComboIndex((i) => Math.min(i + 1, repoMatches.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setComboIndex((i) => Math.max(i - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const pick = repoMatches[comboIndex];
                if (pick) {
                  void mutateWatchlist("POST", pick.slug);
                  setRepoQuery("");
                  setComboOpen(false);
                }
              } else if (event.key === "Escape") {
                setComboOpen(false);
              }
            }}
          />
          {comboOpen && remoteRepos.length > 0 && (
            <div className="combo-list" id="repo-matches" role="listbox">
              {repoMatches.length === 0 ? (
                <div className="combo-note">
                  {repoQuery.trim()
                    ? `Nothing matches “${repoQuery.trim()}”.`
                    : "Every repository is already watched."}
                </div>
              ) : (
                repoMatches.map((repo, index) => (
                  <button
                    type="button"
                    key={repo.slug}
                    role="option"
                    aria-selected={index === comboIndex}
                    className={`combo-item ${index === comboIndex ? "active" : ""}`}
                    onMouseEnter={() => setComboIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      void mutateWatchlist("POST", repo.slug);
                      setRepoQuery("");
                      setComboOpen(false);
                    }}
                  >
                    {repo.slug}
                    {repo.isPrivate && <span className="tagline"> · private</span>}
                    {repo.isArchived && <span className="tagline"> · archived</span>}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {repoRows.length === 0 ? (
          <p className="small">
            Nothing watched yet. Add a repository above and the watcher picks it up on its
            next cycle.
          </p>
        ) : (
          <table style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>repo</th>
                <th className="n">open</th>
                <th className="n">conflicting</th>
                <th className="n">failing CI</th>
                <th>last activity</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {repoRows.map((repo) => (
                <tr key={repo.slug}>
                  <td className="mono">
                    <a href={`https://github.com/${repo.slug}`} target="_blank" rel="noreferrer">
                      {repo.slug}
                    </a>
                  </td>
                  <td className="n">
                    {repo.open > 0 ? (
                      <a
                        href={`https://github.com/${repo.slug}/pulls`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {repo.open}
                      </a>
                    ) : (
                      <span className="faint">0</span>
                    )}
                  </td>
                  <td className="n">
                    {repo.conflicting > 0 ? (
                      <span className="badge bad">{repo.conflicting}</span>
                    ) : (
                      <span className="faint">0</span>
                    )}
                  </td>
                  <td className="n">
                    {repo.failing > 0 ? (
                      <span className="badge bad">{repo.failing}</span>
                    ) : (
                      <span className="faint">0</span>
                    )}
                  </td>
                  <td className="small">
                    {repo.lastAt ? ago(repo.lastAt, now) : <span className="faint">—</span>}
                  </td>
                  <td className="n">
                    <button
                      type="button"
                      className="chip"
                      disabled={busy}
                      onClick={() => void mutateWatchlist("DELETE", repo.slug)}
                    >
                      stop watching
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>
          Pull requests &amp; pushes{" "}
          {shown.length > 0 && <span className="faint">— {shown.length}</span>}
        </h2>
        {events.length >= 500 && (
          <p className="small faint">
            The log keeps the most recent 500 events; anything older is not shown here.
          </p>
        )}

        {shown.length === 0 ? (
          <p className="small" style={{ marginTop: 10 }}>
            {events.length === 0
              ? "No activity recorded yet — the watcher baselines a repo on its first cycle, then reports what changes."
              : "Nothing in this window matches those filters."}
          </p>
        ) : (
          <table style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>arrived</th>
                <th>repo</th>
                <th>what</th>
                <th>coder</th>
                <th>conflict</th>
                <th>CI</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((event) => {
                const pr =
                  event.number !== null
                    ? prIndex.get(`${event.repo}#${event.number}`)
                    : undefined;
                const repoUrl = `https://github.com/${event.repo}`;
                return (
                  <tr key={event.id} className={freshIds.has(event.id) ? "fresh" : undefined}>
                    <td
                      className="mono"
                      title={`happened ${event.at}\nfirst seen here ${event.observedAt}`}
                    >
                      {ago(event.observedAt, now)}
                    </td>
                    <td className="mono">
                      <a href={repoUrl} target="_blank" rel="noreferrer">
                        {event.repo.split("/")[1]}
                      </a>
                    </td>
                    <td>
                      <span className="ev-title">
                        {KIND_TONE[event.kind] ? (
                          <span className={`badge ${KIND_TONE[event.kind]}`}>
                            {KIND_LABEL[event.kind]}
                          </span>
                        ) : (
                          <span className="faint">{KIND_LABEL[event.kind]}</span>
                        )}{" "}
                        {event.number !== null && (
                          <>
                            <a href={event.url} target="_blank" rel="noreferrer">
                              #{event.number}
                            </a>{" "}
                          </>
                        )}
                        {event.title}
                      </span>
                      <span className="ev-meta">
                        {pr?.headRefName && (
                          <>
                            <a
                              href={`${repoUrl}/tree/${encodeURIComponent(pr.headRefName)}`}
                              target="_blank"
                              rel="noreferrer"
                              title="branch on GitHub"
                            >
                              {pr.headRefName}
                            </a>
                            {" · "}
                          </>
                        )}
                        {pr?.authorLogin && (
                          <>
                            <a
                              href={`https://github.com/${pr.authorLogin}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {pr.authorLogin}
                            </a>
                            {" · "}
                          </>
                        )}
                        {event.detail}
                        {pr && pr.state !== "open" && <> · {pr.state}</>}
                      </span>
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
                    <td>{conflictBadge(event.conflict)}</td>
                    <td>
                      {event.number !== null && event.ci !== "none" ? (
                        <a
                          href={`${event.url}/checks`}
                          target="_blank"
                          rel="noreferrer"
                          title="checks on GitHub"
                        >
                          {ciBadge(event.ci, event.ciFailing)}
                        </a>
                      ) : (
                        ciBadge(event.ci, event.ciFailing)
                      )}
                    </td>
                    <td className="ext-cell">
                      <a
                        className="ext"
                        href={event.url}
                        target="_blank"
                        rel="noreferrer"
                        title="open on GitHub"
                      >
                        ↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * Says where the summary came from. A template means every model draft named a
 * number the facts did not support, so the facts are shown plainly instead.
 */
function summaryLabel(meta: {
  ms: number;
  cached: boolean;
  model: string;
  source: "model" | "template";
  attempts: number;
}): string {
  const timing = meta.cached ? "cached" : `${(meta.ms / 1000).toFixed(1)}s`;
  if (meta.source === "template") {
    return meta.attempts ? `${meta.model} drafts failed the number check · facts only · ${timing}` : timing;
  }
  const corrected = meta.attempts > 1 ? ` · corrected ${meta.attempts - 1}×` : "";
  return `${meta.model}${corrected} · ${timing}`;
}
