// The release workflow's steps, as commands so they run the same locally (`.github/workflows/release.yml`):
//   bun scripts/release.ts tag <tag>                 checks that <tag> is a release tag naming the host's VERSION;
//                                                    prints `version=` and `prerelease=` (also appended to $GITHUB_OUTPUT)
//   bun scripts/release.ts desktop <bundleDir> <hostDir> <outDir> <version> <arch>...
//                                                    checks a `package:desktop` run for this OS against the release (the
//                                                    host in every app is the binary in <hostDir>, the metadata names
//                                                    <version>) and copies its installers and metadata into <outDir>
//   bun scripts/release.ts checksums <dir> <version> checks <dir> holds all five host binaries and every supported OS's
//                                                    installers and metadata, then writes SHA256SUMS over every file in it
// Exits non-zero, with the reason on stderr, when a check fails.
import { appendFileSync } from "node:fs";

import {
  collectDesktopRelease,
  type DesktopPlatform,
  isDesktopArch,
  releaseAssets,
} from "./desktop-kit.ts";
import { releaseForTag, writeChecksums } from "./release-kit.ts";

const USAGE =
  "usage: bun scripts/release.ts tag <tag> | desktop <bundleDir> <hostDir> <outDir> <version> <arch>... | checksums <dir> <version>";

const isDesktopPlatform = (name: string): name is DesktopPlatform =>
  name === "darwin" || name === "win32" || name === "linux";

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "tag" && args.length === 1) {
    // Dynamic: only this command needs the host's dependencies installed; the others run in jobs that install little.
    const { VERSION } = await import("../packages/host/src/harness/claude-access.ts");
    const { version, prerelease } = releaseForTag(args[0] as string, VERSION);
    const lines = `version=${version}\nprerelease=${prerelease}\n`;
    process.stdout.write(lines);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
    return 0;
  }
  if (command === "desktop" && args.length >= 5) {
    const [bundleDir, hostDir, outDir, version, ...archs] = args as [
      string,
      string,
      string,
      string,
      ...string[],
    ];
    if (!isDesktopPlatform(process.platform) || !archs.every(isDesktopArch)) {
      console.error(
        `unsupported OS ${process.platform} or arch ${archs.join(", ")}; arch is arm64 or x64`,
      );
      return 2;
    }
    const collected = await collectDesktopRelease({
      bundleDir,
      hostDir,
      outDir,
      platform: process.platform,
      archs,
      version,
    });
    process.stdout.write(`${collected.join("\n")}\n`);
    return 0;
  }
  if (command === "checksums" && args.length === 2) {
    process.stdout.write(await writeChecksums(args[0] as string, releaseAssets(args[1] as string)));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

process.exitCode = await main().catch((e: Error) => {
  console.error(e.message);
  return 1;
});
