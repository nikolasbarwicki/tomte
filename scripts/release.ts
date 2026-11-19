// The release workflow's steps, as commands so they run the same locally (`.github/workflows/release.yml`):
//   bun scripts/release.ts tag <tag>                 checks that <tag> is a release tag naming the host's VERSION;
//                                                    prints `version=` and `prerelease=` (also appended to $GITHUB_OUTPUT)
//   bun scripts/release.ts desktop <bundleDir> <hostDir> <outDir> <version> <arch>...
//                                                    checks a `package:desktop` run for this OS against the release (the
//                                                    host in every app is the binary in <hostDir>, the metadata names
//                                                    <version>) and copies its installers and metadata into <outDir>
//   bun scripts/release.ts signing-ready             fails unless the release public key is pinned in deploy/install.sh and the
//                                                    private key secret is set ($RELEASE_SIGNING_KEY_SET is `set`); run first
//   bun scripts/release.ts manifest <dir> <version>  writes release.json (version, SHELL_API, SCHEMA_VERSION) into <dir>
//   bun scripts/release.ts checksums <dir> <version> checks <dir> holds all five host binaries, release.json and every
//                                                    supported OS's installers and metadata, then writes SHA256SUMS over every
//                                                    file in it
//   bun scripts/release.ts sign <dir>                signs <dir>/SHA256SUMS with the PEM Ed25519 key in $RELEASE_SIGNING_KEY and
//                                                    writes SHA256SUMS.sig; fails when the key is unset or is not the pinned key's pair
//   bun scripts/release.ts verify-release <dir> <version>
//                                                    checks a downloaded Release folder (`gh release download <tag> -D <dir>`):
//                                                    every asset present, SHA256SUMS exact and matching and signed by the pinned
//                                                    key, release.json naming <version>, install.sh's DEFAULT_REPO set and its
//                                                    pinned key this checkout's, every latest*.yml naming <version> with the real
//                                                    sha512/size
import { appendFileSync } from "node:fs";

import { SHELL_API } from "../packages/contract/src/api.ts";
import {
  collectDesktopRelease,
  type DesktopPlatform,
  isDesktopArch,
  releaseAssets,
} from "./desktop-kit.ts";
import {
  MANIFEST_FILE,
  pinnedPublicKey,
  releaseForTag,
  signChecksums,
  writeChecksums,
  writeManifest,
} from "./release-kit.ts";
import { verifyRelease } from "./release-verify.ts";

const USAGE =
  "usage: bun scripts/release.ts tag <tag> | signing-ready | manifest <dir> <version> | desktop <bundleDir> <hostDir> <outDir> <version> <arch>... | checksums <dir> <version> | sign <dir> | verify-release <dir> <version>";

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
  if (command === "signing-ready" && args.length === 0) {
    await pinnedPublicKey();
    if (process.env.RELEASE_SIGNING_KEY_SET !== "set") {
      throw new Error(
        'the repository secret RELEASE_SIGNING_KEY is not set: a release is never published with unsigned checksums (docs/release/signing.md, "One-time setup")',
      );
    }
    return 0;
  }
  if (command === "manifest" && args.length === 2) {
    // Dynamic, like `tag`: only this command needs the host's dependencies (bun:sqlite) installed.
    const { SCHEMA_VERSION } = await import("../packages/host/src/platform/db.ts");
    await writeManifest(args[0] as string, {
      version: args[1] as string,
      shellApi: SHELL_API,
      schemaVersion: SCHEMA_VERSION,
    });
    return 0;
  }
  if (command === "checksums" && args.length === 2) {
    const required = [...releaseAssets(args[1] as string), MANIFEST_FILE];
    process.stdout.write(await writeChecksums(args[0] as string, required));
    return 0;
  }
  if (command === "sign" && args.length === 1) {
    await signChecksums(
      args[0] as string,
      process.env.RELEASE_SIGNING_KEY ?? "",
      await pinnedPublicKey(),
    );
    return 0;
  }
  if (command === "verify-release" && args.length === 2) {
    const [dir, version] = args as [string, string];
    const problems = await verifyRelease(dir, version, await pinnedPublicKey());
    if (problems.length > 0) {
      console.error(
        `${dir} is not a complete release ${version}:\n${problems.map((p) => `  ${p}`).join("\n")}`,
      );
      return 1;
    }
    process.stdout.write(`${dir} is a complete, consistent release ${version}\n`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

process.exitCode = await main().catch((e: Error) => {
  console.error(e.message);
  return 1;
});
