"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunSummary } from "@/store/store";
import type { RemoteRepo } from "@/engine/github";

type WindowMode = "count" | "since";

interface StreamEvent {
  type: "progress" | "done" | "error";
  message?: string;
  summary?: RunSummary;
}

export default function Home() {
  const [repos, setRepos] = useState("");
  const [mode, setMode] = useState<WindowMode>("count");
  const [count, setCount] = useState(50);
  const [since, setSince] = useState("30d");
  const [allCoders, setAllCoders] = useState<string[]>([]);
  const [selectedCoders, setSelectedCoders] = useState<string[]>([]);
  const [remoteRepos, setRemoteRepos] = useState<RemoteRepo[]>([]);
  const [repoPickerState, setRepoPickerState] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [repoPickerNote, setRepoPickerNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const loadRuns = useCallback(async () => {
    const response = await fetch("/api/runs", { cache: "no-store" });
    if (response.ok) {
      const data = (await response.json()) as { runs: RunSummary[] };
      setRuns(data.runs);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
    void fetch("/api/coders")
      .then((r) => r.json())
      .then((d: { coders: string[] }) => setAllCoders(d.coders))
      .catch(() => setAllCoders([]));

    void fetch("/api/repos", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { repos: RemoteRepo[]; truncated: boolean; error?: string }) => {
        setRemoteRepos(d.repos ?? []);
        if (d.error) {
          setRepoPickerState("failed");
          setRepoPickerNote(d.error);
        } else {
          setRepoPickerState("ready");
          setRepoPickerNote(
            d.truncated ? "most recently pushed only — type others by hand" : null,
          );
        }
      })
      .catch(() => {
        setRepoPickerState("failed");
        setRepoPickerNote("could not reach the repo list");
      });
  }, [loadRuns]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  function toggleCoder(coder: string) {
    setSelectedCoders((current) =>
      current.includes(coder) ? current.filter((c) => c !== coder) : [...current, coder],
    );
  }

  /** What is already in the field, so the picker can mark those entries. */
  const chosenRepos = useMemo(
    () => new Set(repos.split(/[\s,]+/).map((repo) => repo.trim()).filter(Boolean)),
    [repos],
  );

  /** Owner-grouped for the dropdown, each group keeping the push-date order. */
  const reposByOwner = useMemo(() => {
    const groups = new Map<string, RemoteRepo[]>();
    for (const repo of remoteRepos) {
      const group = groups.get(repo.owner);
      if (group) group.push(repo);
      else groups.set(repo.owner, [repo]);
    }
    return [...groups];
  }, [remoteRepos]);

  /** The picker appends rather than replaces — a run can span several repos. */
  function addRepo(slug: string) {
    if (!slug) return;
    setRepos((current) => {
      const list = current.split(/[\s,]+/).map((repo) => repo.trim()).filter(Boolean);
      if (list.includes(slug)) return current;
      return [...list, slug].join(", ");
    });
  }

  async function startRun() {
    const repoList = repos
      .split(/[\s,]+/)
      .map((repo) => repo.trim())
      .filter(Boolean);
    if (repoList.length === 0) {
      setError("Add at least one repository, e.g. owner/name");
      return;
    }

    setRunning(true);
    setError(null);
    setLog([`starting — ${repoList.join(", ")}`]);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repos: repoList,
          count: mode === "count" ? count : undefined,
          since: mode === "since" ? since : undefined,
          coders: selectedCoders.length ? selectedCoders : null,
        }),
      });

      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `request failed (${response.status})`);
      }
      if (!response.body) throw new Error("no response body");

      // Progress arrives as newline-delimited JSON; a chunk can split a line,
      // so hold the remainder until its newline shows up.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as StreamEvent;
          if (event.type === "progress" && event.message) {
            setLog((current) => [...current, event.message as string]);
          } else if (event.type === "error") {
            setError(event.message ?? "analysis failed");
          } else if (event.type === "done" && event.summary) {
            setLog((current) => [...current, `done — ${event.summary?.prCount} PRs analysed`]);
            await loadRuns();
          }
        }
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="wrap">
      <div className="eyebrow">agentic merge forensics</div>
      <h1>Merge health for agent-worked repos</h1>
      <p className="sub">
        Conflict rate, cross-agent overwrites, churn and file contention — measured from git
        itself, by replaying merges and attributing every rewritten line to the PR that wrote
        it. Everything stays on this machine.
      </p>

      <div className="card">
        <h2>New run</h2>
        <div className="field">
          <label htmlFor="repo-picker">
            Your repositories{" "}
            {repoPickerState === "loading" && <span className="faint">— loading…</span>}
            {repoPickerState === "ready" && remoteRepos.length > 0 && (
              <span className="faint">
                — {remoteRepos.length}
                {repoPickerNote ? `, ${repoPickerNote}` : ""}
              </span>
            )}
            {repoPickerState === "failed" && (
              <span className="faint">— {repoPickerNote}, type them below</span>
            )}
          </label>
          <select
            id="repo-picker"
            value=""
            onChange={(event) => addRepo(event.target.value)}
            disabled={running || remoteRepos.length === 0}
          >
            <option value="">
              {remoteRepos.length > 0 ? "Add a repository…" : "No repositories available"}
            </option>
            {reposByOwner.map(([owner, ownerRepos]) => (
              <optgroup key={owner} label={owner}>
                {ownerRepos.map((repo) => {
                  const tags = [
                    repo.isPrivate ? "private" : null,
                    repo.isFork ? "fork" : null,
                    repo.isArchived ? "archived" : null,
                  ].filter(Boolean);
                  return (
                    <option key={repo.slug} value={repo.slug}>
                      {chosenRepos.has(repo.slug) ? "✓ " : ""}
                      {repo.name}
                      {tags.length > 0 ? ` · ${tags.join(", ")}` : ""}
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="repos">Repositories</label>
          <input
            id="repos"
            type="text"
            placeholder="owner/name, owner/other — or paste GitHub URLs"
            value={repos}
            onChange={(event) => setRepos(event.target.value)}
            disabled={running}
          />
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <div className="field">
            <label htmlFor="mode">Window</label>
            <select
              id="mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as WindowMode)}
              disabled={running}
            >
              <option value="count">Most recent N merges</option>
              <option value="since">Merged since…</option>
            </select>
          </div>
          {mode === "count" ? (
            <div className="field">
              <label htmlFor="count">How many PRs</label>
              <input
                id="count"
                type="number"
                min={1}
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
                disabled={running}
              />
            </div>
          ) : (
            <div className="field">
              <label htmlFor="since">Since</label>
              <input
                id="since"
                type="text"
                placeholder="30d, 12h, 2w or 2026-08-01"
                value={since}
                onChange={(event) => setSince(event.target.value)}
                disabled={running}
              />
            </div>
          )}
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <label>Coders {selectedCoders.length === 0 && <span className="faint">— all</span>}</label>
          <div className="chips">
            {allCoders.map((coder) => (
              <button
                type="button"
                key={coder}
                className={`chip ${selectedCoders.includes(coder) ? "on" : ""}`}
                onClick={() => toggleCoder(coder)}
                disabled={running}
              >
                {coder}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center" }}>
          <button onClick={startRun} disabled={running}>
            {running ? "Analysing…" : "Run analysis"}
          </button>
          <span className="small">
            First run on a repo clones it, so it is slower; later runs fetch incrementally.
          </span>
        </div>

        {error && <div className="err">{error}</div>}
        {log.length > 0 && (
          <div className="log" ref={logRef}>
            {log.join("\n")}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Past runs</h2>
        {runs.length === 0 ? (
          <p className="small">No runs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>when</th>
                <th>repos</th>
                <th className="n">PRs</th>
                <th className="n">conflicts</th>
                <th className="n">cross-agent</th>
                <th className="n">churn</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="mono">{run.generatedAt.slice(0, 16).replace("T", " ")}</td>
                  <td>
                    {run.repos.join(", ")}
                    {run.coderFilter && (
                      <span className="faint"> · {run.coderFilter.join(", ")}</span>
                    )}
                  </td>
                  <td className="n">{run.prCount}</td>
                  <td className="n">
                    <span className={`badge ${run.conflictRatePct <= 5 ? "good" : "warn"}`}>
                      {run.conflictRatePct}%
                    </span>
                  </td>
                  <td className="n">
                    <span
                      className={`badge ${run.crossCoderFreshOverwriteLines === 0 ? "good" : "warn"}`}
                    >
                      {run.crossCoderFreshOverwriteLines}
                    </span>
                  </td>
                  <td className="n">{run.churnRatePct}%</td>
                  <td className="n">
                    <a href={`/api/report/${run.id}`} target="_blank" rel="noreferrer">
                      open report
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="small" style={{ marginTop: 24 }}>
        Automated runs with alerts:{" "}
        <code>merge-forensics watch --repo owner/name --every 25</code>
      </p>
    </div>
  );
}
