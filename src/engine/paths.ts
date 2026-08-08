/**
 * Where the tool keeps state.
 *
 * Everything lives under one home directory so the whole install is one thing
 * to inspect, back up, or delete: mirror clones, finished reports, run history
 * and scheduler watermarks. Override with MERGE_FORENSICS_HOME (the tests do).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function forensicsHome(): string {
  return process.env.MERGE_FORENSICS_HOME || join(homedir(), ".merge-forensics");
}

export function clonesDir(): string {
  return join(forensicsHome(), "clones");
}

export function reportsDir(): string {
  return join(forensicsHome(), "reports");
}

export function stateDir(): string {
  return join(forensicsHome(), "state");
}

/** Mirror clones are flat, so `owner/name` becomes `owner__name.git`. */
export function clonePath(owner: string, name: string): string {
  return join(clonesDir(), `${owner}__${name}.git`);
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureHomeLayout(): void {
  ensureDir(clonesDir());
  ensureDir(reportsDir());
  ensureDir(stateDir());
}
