#!/usr/bin/env node
// Thin launcher so the CLI can be run as `merge-forensics` without a build
// step. tsx compiles the TypeScript entry point on the fly.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../src/cli/main.ts");
const result = spawnSync(
  process.execPath,
  [resolve(here, "../node_modules/tsx/dist/cli.mjs"), entry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
