import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

// Packages the desktop app for this machine, unsigned and unnotarized, into dist/desktop/ (gitignored):
//   bun run package:desktop [--out <dir>]
// Builds the host binary for this machine, bundles the main process and runs @electron/packager with asar on.
// The host binary goes in as the extra resource `claudebot-host`, next to the app's other resources.
// It refuses, before building or deleting anything, when a process is running from the bundle it would replace.
import { packager } from "@electron/packager";

import { ASSETS_OUT, buildMain, MAIN_OUT } from "./build-desktop.ts";
import { processes, processesUnder, refusal } from "./process-guard.ts";

const ROOT = join(import.meta.dir, "..");
const { values: flags } = parseArgs({ options: { out: { type: "string" } } });
const OUT = resolve(flags.out ?? join(ROOT, "dist/desktop"));
const STAGE = join(OUT, ".stage");
const APP_NAME = "Claudebot";
const BUNDLE_ID = "dev.claudebot.desktop";

const HOST_OS = process.platform === "win32" ? "windows" : process.platform;
const HOST_TARGET = `${HOST_OS}-${process.arch}`;
const HOST_EXE = process.platform === "win32" ? ".exe" : "";

/** The version of the Electron the desktop package installed, which is the one the app is built on. */
function electronVersion(): string {
  const manifest = Bun.resolveSync("electron/package.json", join(ROOT, "packages/desktop"));
  return (require(manifest) as { version: string }).version;
}

async function buildHost(): Promise<string> {
  const build = Bun.spawn(["bun", "scripts/build-host.ts", HOST_TARGET], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) throw new Error(`building the ${HOST_TARGET} host failed`);
  return join(ROOT, "dist/host", `claudebot-host-${HOST_TARGET}${HOST_EXE}`);
}

/** Stops, before anything is built or deleted, when a process runs from the bundle that packaging would replace. */
function refuseWhileRunning(bundleDir: string): void {
  const running = processesUnder(bundleDir, processes());
  if (running.length > 0) throw new Error(refusal("package", bundleDir, running));
}

async function main(): Promise<void> {
  const bundleDir = join(OUT, `${APP_NAME}-${process.platform}-${process.arch}`);
  refuseWhileRunning(bundleDir);
  const hostBinary = await buildHost();
  await buildMain();

  await rm(bundleDir, { recursive: true, force: true });
  await rm(STAGE, { recursive: true, force: true });
  const appDir = join(STAGE, "app");
  await mkdir(appDir, { recursive: true });
  await copyFile(MAIN_OUT, join(appDir, "main.cjs"));
  await cp(ASSETS_OUT, join(appDir, "assets"), { recursive: true });
  await writeFile(
    join(appDir, "package.json"),
    `${JSON.stringify({ name: "claudebot-desktop", productName: APP_NAME, version: "0.0.0", main: "main.cjs" }, null, 2)}\n`,
  );
  const resource = join(STAGE, `claudebot-host${HOST_EXE}`);
  await copyFile(hostBinary, resource);

  try {
    const [appPath] = await packager({
      dir: appDir,
      out: OUT,
      name: APP_NAME,
      appBundleId: BUNDLE_ID,
      electronVersion: electronVersion(),
      platform: process.platform,
      arch: process.arch,
      asar: true,
      prune: false,
      overwrite: true,
      extraResource: [resource],
      quiet: true,
    });
    console.log(`packaged ${relative(ROOT, appPath ?? OUT)}`);
  } finally {
    await rm(STAGE, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
