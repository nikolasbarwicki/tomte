// Runs the browser smokes (the answer path, the double-loop chat mode and the transcript's scrolling) one after another and stops at the first one that fails, exiting with its status
// (a smoke killed by a signal counts as 1): no failure is swallowed into an overall pass.
//   bun run smoke:ui                      all of them
//   bun scripts/smoke-ui.ts a.ts b.ts     only these (paths relative to the working directory)
// The web UI is built once into a temporary directory that every smoke serves (SMOKE_WEB_DIST; one already set in the environment
// is used as it is and never deleted). Each smoke keeps its own run directory when it fails and prints where.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWeb } from "./smoke-kit.ts";

const SMOKES = [
  "scripts/smoke-answer-ui.ts",
  "scripts/smoke-needs-you-ui.ts",
  "scripts/smoke-blocked-ui.ts",
  "scripts/smoke-answers.ts",
  "scripts/smoke-loop-ui.ts",
  "scripts/smoke-scroll-ui.ts",
];
const scripts = process.argv.length > 2 ? process.argv.slice(2) : SMOKES;

const ownDist =
  process.env.SMOKE_WEB_DIST === undefined
    ? await mkdtemp(join(tmpdir(), "claudebot-smoke-web-"))
    : undefined;
if (ownDist !== undefined) buildWeb(ownDist);
const dist = ownDist ?? process.env.SMOKE_WEB_DIST;

let status = 0;
for (const script of scripts) {
  console.log(`\n=== ${script}`);
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, ...(dist !== undefined && { SMOKE_WEB_DIST: dist }) },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    console.error(`\nsmoke-ui: ${script} failed (exit ${code}); the remaining smokes were not run`);
    status = code;
    break;
  }
}
if (ownDist !== undefined) await rm(ownDist, { recursive: true, force: true });
if (status === 0) console.log(`\nsmoke-ui: all ${scripts.length} smokes passed`);
process.exit(status);
