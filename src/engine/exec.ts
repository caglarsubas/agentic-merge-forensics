/**
 * Process helpers.
 *
 * Everything here uses execFile rather than a shell: arguments come from repo
 * names, branch names and file paths, none of which are trustworthy enough to
 * interpolate into a shell string.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  cwd?: string;
  /** Bytes of stdout to allow. `git blame` over a large file is not small. */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Run a command and return its result. Non-zero exit is *returned*, not thrown
 * — callers here routinely care about specific exit codes (`git merge-tree`
 * uses 1 to mean "conflict", which is a finding rather than an error).
 */
export async function run(
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
      env: options.env ?? process.env,
      timeout: options.timeoutMs ?? 0,
      encoding: "utf8",
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? error),
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

/** Run and throw on failure, for the cases where non-zero is genuinely fatal. */
export async function runOrThrow(
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  const result = await run(file, args, options);
  if (result.code !== 0) {
    throw new Error(
      `command_failed:${file} ${args.slice(0, 4).join(" ")} exit=${result.code}: ${result.stderr.slice(0, 400)}`,
    );
  }
  return result.stdout;
}

/** Bounded-concurrency map — git subprocesses are cheap but not free. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
