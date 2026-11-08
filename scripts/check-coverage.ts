// Fails when the repo-wide line or function coverage of the last `bun test` run is below the baselines.
// Bun's own `coverageThreshold` is per file, so it cannot gate the total; this script does.
// Baselines are the measured totals rounded down to a whole percent. Raise them as tests land, never lower them.
import { readFile } from "node:fs/promises";

const BASELINE = { lines: 94, functions: 91 };

const LCOV_PATH = "coverage/lcov.info";

async function main(): Promise<number> {
  let lcov: string;
  try {
    lcov = await readFile(LCOV_PATH, "utf8");
  } catch {
    console.error(`${LCOV_PATH} not found: run \`bun test\` first (bunfig.toml writes it).`);
    return 1;
  }

  const sums = { LF: 0, LH: 0, FNF: 0, FNH: 0 };
  for (const line of lcov.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon);
    if (key === "LF" || key === "LH" || key === "FNF" || key === "FNH") {
      sums[key] += Number(line.slice(colon + 1));
    }
  }
  if (sums.LF === 0 || sums.FNF === 0) {
    console.error(`${LCOV_PATH} has no line or function records.`);
    return 1;
  }

  const actual = { lines: (sums.LH / sums.LF) * 100, functions: (sums.FNH / sums.FNF) * 100 };
  let failed = false;
  for (const kind of ["lines", "functions"] as const) {
    const ok = actual[kind] >= BASELINE[kind];
    failed ||= !ok;
    console.log(
      `${ok ? "ok  " : "FAIL"} total ${kind} coverage ${actual[kind].toFixed(2)}% (baseline ${BASELINE[kind]}%)`,
    );
  }
  if (failed) console.error("Coverage dropped below the baseline: add tests for the new code.");
  return failed ? 1 : 0;
}

process.exitCode = await main();
