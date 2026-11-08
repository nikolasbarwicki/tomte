// The release workflow's two steps, as commands so they run the same locally (`.github/workflows/release.yml`):
//   bun scripts/release.ts tag <tag>        checks that <tag> is a release tag naming the host's VERSION; prints
//                                           `version=` and `prerelease=` (also appended to $GITHUB_OUTPUT when set)
//   bun scripts/release.ts checksums <dir>  checks <dir> holds all five host binaries, then writes SHA256SUMS over
//                                           every file in it
// Exits non-zero, with the reason on stderr, when a check fails.
import { appendFileSync } from "node:fs";

import { HOST_BINARIES, releaseForTag, writeChecksums } from "./release-kit.ts";

async function main(): Promise<number> {
  const [command, arg] = process.argv.slice(2);
  if (!arg) {
    console.error("usage: bun scripts/release.ts tag <tag> | checksums <dir>");
    return 2;
  }
  if (command === "tag") {
    // Dynamic: only this command needs the host's dependencies installed; `checksums` runs in a job that installs nothing.
    const { VERSION } = await import("../packages/host/src/harness/claude-access.ts");
    const { version, prerelease } = releaseForTag(arg, VERSION);
    const lines = `version=${version}\nprerelease=${prerelease}\n`;
    process.stdout.write(lines);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
    return 0;
  }
  if (command === "checksums") {
    process.stdout.write(await writeChecksums(arg, HOST_BINARIES));
    return 0;
  }
  console.error(`unknown command ${command}; expected tag or checksums`);
  return 2;
}

process.exitCode = await main().catch((e: Error) => {
  console.error(e.message);
  return 1;
});
