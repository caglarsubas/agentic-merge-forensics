/**
 * Reading and writing the small JSON files the stores keep.
 *
 * Lifted out of store.ts once the feed needed the same two functions, and kept
 * together because they are two halves of one bargain: writes go through a
 * temp file and a rename so a crash cannot leave a half-written state file
 * behind, and reads swallow a parse error so the half-file that gets through
 * anyway (a filesystem that reorders, an editor that saves in place) costs the
 * user their last write rather than the whole tool. All of this state is
 * regenerable; none of it is worth a crash.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // A truncated file from an interrupted write should not brick the tool.
    return fallback;
  }
}

export function writeJson(path: string, value: unknown): void {
  // Write-then-rename so a crash mid-write cannot leave a half-file behind.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(temporary, path);
  } catch {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
