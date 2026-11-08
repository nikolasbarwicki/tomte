import { BUNDLE_DIR } from "../packages/host/src/browser/engine.ts";
import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

// Packages the desktop app for this machine, unsigned and unnotarized, into dist/desktop/ (gitignored):
//   bun run package:desktop [--out <dir>] [--version <semver>]
// Builds the host binary for this machine, bundles the main process and runs electron-builder with asar on. It writes,
// into <out>/Claudebot-<os>-<arch>/, the installers (macOS: dmg and zip; Windows: NSIS; Linux: AppImage and deb), the
// update metadata electron-updater reads (latest-mac.yml, latest.yml, latest-linux.yml) and the unpacked app
// (mac-<arch>/Claudebot.app, win-unpacked/, linux-unpacked/). Nothing is published and nothing is signed.
// The host binary goes in as the extra resource `claudebot-host`, next to the app's other resources, and the browser
// (scripts/browser-bundle.ts) as `browser-engine` beside it, where the host looks for it.
// It refuses, before building or deleting anything, when a process is running from the folder it would replace.
import { build, Platform } from "electron-builder";

import { prepareBrowserBundle } from "./browser-bundle.ts";
import { ASSETS_OUT, buildMain, MAIN_OUT } from "./build-desktop.ts";
import { processes, processesUnder, refusal } from "./process-guard.ts";

const ROOT = join(import.meta.dir, "..");
const { values: flags } = parseArgs({
  options: { out: { type: "string" }, version: { type: "string" } },
});
const OUT = resolve(flags.out ?? join(ROOT, "dist/desktop"));
const STAGE = join(OUT, ".stage");
const APP_NAME = "Claudebot";
const BUNDLE_ID = "dev.claudebot.desktop";
/** Placeholder until the release wires the real one: the app's version, and so the installers' names and update metadata. */
const VERSION = flags.version ?? "0.0.0";
/** `owner/repo`, set by GitHub Actions. Local builds have no repository coordinates. */
const REPOSITORY = process.env.GITHUB_REPOSITORY;

const HOST_OS = process.platform === "win32" ? "windows" : process.platform;
const HOST_TARGET = `${HOST_OS}-${process.arch}`;
const HOST_EXE = process.platform === "win32" ? ".exe" : "";

/** Credentials that would make electron-builder sign or publish; an unsigned build never sees them. */
const SIGNING_AND_PUBLISH_ENV = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];

const INSTALLER_TARGETS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["dmg", "zip"],
  win32: ["nsis"],
  linux: ["AppImage", "deb"],
};

/** The version of the Electron the desktop package installed, which is the one the app is built on. */
function electronVersion(): string {
  const manifest = Bun.resolveSync("electron/package.json", join(ROOT, "packages/desktop"));
  return (require(manifest) as { version: string }).version;
}

/** Where the app looks for updates. In CI that is this repository's GitHub Releases; locally there is no repository, so the placeholder host (reserved `.invalid`, never resolves) keeps the metadata well-formed. */
function updateProvider() {
  if (REPOSITORY === undefined) {
    return { provider: "generic" as const, url: "https://updates.invalid/claudebot" };
  }
  const [owner, repo] = REPOSITORY.split("/");
  return { provider: "github" as const, owner, repo };
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

/** Stops, before anything is built or deleted, when a process runs from the folder that packaging would replace. */
function refuseWhileRunning(bundleDir: string): void {
  const running = processesUnder(bundleDir, processes());
  if (running.length > 0) throw new Error(refusal("package", bundleDir, running));
}

async function main(): Promise<void> {
  const bundleDir = join(OUT, `${APP_NAME}-${process.platform}-${process.arch}`);
  refuseWhileRunning(bundleDir);
  const targets = INSTALLER_TARGETS[process.platform];
  if (targets === undefined) throw new Error(`no installer is defined for ${process.platform}`);
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
    `${JSON.stringify(
      {
        name: "claudebot-desktop",
        productName: APP_NAME,
        version: VERSION,
        description: "Claudebot desktop app",
        author: APP_NAME,
        ...(REPOSITORY === undefined ? {} : { homepage: `https://github.com/${REPOSITORY}` }),
        main: "main.cjs",
      },
      null,
      2,
    )}\n`,
  );
  const resource = join(STAGE, `claudebot-host${HOST_EXE}`);
  await copyFile(hostBinary, resource);
  const browser = await prepareBrowserBundle(STAGE);

  for (const name of SIGNING_AND_PUBLISH_ENV) delete process.env[name];
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  try {
    const artifacts = await build({
      projectDir: appDir,
      targets: Platform.current().createTarget(targets),
      publish: "never",
      config: {
        appId: BUNDLE_ID,
        productName: APP_NAME,
        electronVersion: electronVersion(),
        asar: true,
        npmRebuild: false,
        directories: { output: bundleDir },
        extraResources: [
          { from: resource, to: `claudebot-host${HOST_EXE}` },
          { from: browser, to: BUNDLE_DIR },
        ],
        publish: updateProvider(),
        mac: { identity: null, notarize: false, category: "public.app-category.developer-tools" },
        nsis: { artifactName: "${productName}-Setup-${version}.${ext}" },
        linux: { category: "Development", executableName: "claudebot", maintainer: APP_NAME },
      },
    });
    for (const artifact of artifacts) console.log(`built ${relative(ROOT, artifact)}`);
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
