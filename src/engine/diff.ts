/**
 * Parsing git's diff output.
 *
 * The overwrite metric needs to know, for every line a PR *removed or
 * replaced*, which line number it occupied in the old file — that is the line
 * blame can attribute to an earlier PR. `-U0` gives exactly those ranges and
 * nothing else.
 */

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface DiffFile {
  /** Path on the old side; null when the file is newly added. */
  oldPath: string | null;
  /** Path on the new side; null when the file is deleted. */
  newPath: string | null;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse `git diff -M -U0` output into per-file hunk ranges. */
export function parseUnifiedZeroDiff(stdout: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { oldPath: null, newPath: null, binary: false, hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith("--- ")) {
      const path = line.slice(4);
      current.oldPath = path === "/dev/null" ? null : stripPrefix(path);
    } else if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      current.newPath = path === "/dev/null" ? null : stripPrefix(path);
    } else if (line.startsWith("Binary files ")) {
      current.binary = true;
    } else if (line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      current.newPath = line.slice("rename to ".length);
    } else if (line.startsWith("@@ ")) {
      const match = HUNK_HEADER.exec(line);
      if (match) {
        current.hunks.push({
          oldStart: Number(match[1]),
          oldLines: match[2] === undefined ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newLines: match[4] === undefined ? 1 : Number(match[4]),
        });
      }
    }
  }
  return files;
}

function stripPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

/** Old-side line numbers a file's hunks touched. */
export function oldSideLineNumbers(file: DiffFile): number[] {
  const lines: number[] = [];
  for (const hunk of file.hunks) {
    // oldLines === 0 means a pure insertion: it displaces nothing, so there is
    // no pre-existing line to attribute to anyone.
    for (let i = 0; i < hunk.oldLines; i++) {
      lines.push(hunk.oldStart + i);
    }
  }
  return lines;
}

export interface NumstatEntry {
  path: string;
  additions: number | null;
  deletions: number | null;
}

/** Parse `git diff -M --numstat`, resolving rename braces to the new path. */
export function parseNumstat(stdout: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [adds, dels] = parts;
    const path = parts.slice(2).join("\t");
    entries.push({
      path: resolveRenamePath(path),
      additions: adds === "-" ? null : Number(adds),
      deletions: dels === "-" ? null : Number(dels),
    });
  }
  return entries;
}

/** `src/{old => new}/file.ts` and `old.ts => new.ts` both become the new path. */
export function resolveRenamePath(path: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (braced) {
    const joined = `${braced[1]}${braced[3]}${braced[4]}`;
    return joined.replace(/\/{2,}/g, "/");
  }
  if (path.includes(" => ")) {
    return path.split(" => ").pop() as string;
  }
  return path;
}

/** Files whose blame is noise: generated, vendored, or not really source. */
const UNINTERESTING = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)go\.sum$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)composer\.lock$/,
  /\.snap$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /(^|\/)dist\//,
  /(^|\/)vendor\//,
];

export function isUninterestingPath(path: string): boolean {
  return UNINTERESTING.some((pattern) => pattern.test(path));
}
