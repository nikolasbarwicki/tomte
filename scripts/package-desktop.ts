import { chmod, copyFile, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

// Packages the desktop app for this machine, unsigned and unnotarized, into dist/desktop/ (gitignored):
//   bun run package:desktop [--out <dir>] [--version <semver>] [--arch <arm64|x64>]... [--host-dir <dir>]
// Bundles the main process and runs electron-builder with asar on. It writes, into <out>/Claudebot-<os>-<archs>/, the
// installers (macOS: dmg and zip; Windows: NSIS; Linux: AppImage and deb), the update metadata electron-updater reads
// (latest-mac.yml, latest.yml, latest-linux.yml) and the unpacked app (mac-<arch>/Claudebot.app, win-unpacked/,
// linux-unpacked/). Nothing is published and nothing is signed.
// The host binary goes in as the extra resource `claudebot-host`, next to the app's other resources, and the browser
// (scripts/browser-bundle.ts, for the arch being packaged) as `browser-engine` beside it, where the host looks for it.
// By default each arch's host is built for this run into dist/host; `--host-dir` bundles the already-built binaries in
// <dir> instead (named claudebot-host-<os>-<arch>[.exe], as build:host and the release workflow's artifacts are) and
// builds none.
// `--arch` (repeatable, default this machine's) packages several CPUs in one run, which is how the macOS release gets one
// latest-mac.yml for both arm64 and x64 (electron-builder writes one file per OS and run). `--version` defaults to the host's VERSION.
// It refuses, before building or deleting anything, when a process is running from the folder it would replace.
import { archFromString, build, Platform } from "electron-builder";

import { BUNDLE_DIR } from "../packages/host/src/browser/engine.ts";
import { VERSION as HOST_VERSION } from "../packages/host/src/harness/claude-access.ts";
import { prepareBrowserBundle } from "./browser-bundle.ts";
import { ASSETS_OUT, buildMain, MAIN_OUT } from "./build-desktop.ts";
import {
  APP_NAME,
  bundleDirName,
  type DesktopArch,
  type DesktopPlatform,
  hostBinaryName,
  hostTarget,
  inCi,
  isDesktopArch,
  updateProvider,
} from "./desktop-kit.ts";
import { processes, processesUnder, refusal } from "./process-guard.ts";

const ROOT = join(import.meta.dir, "..");
const { values: flags } = parseArgs({
  options: {
    out: { type: "string" },
    version: { type: "string" },
    arch: { type: "string", multiple: true },
    "host-dir": { type: "string" },
  },
});
const OUT = resolve(flags.out ?? join(ROOT, "dist/desktop"));
const STAGE = join(OUT, ".stage");
const BUNDLE_ID = "dev.claudebot.desktop";
/** The app's version, and so the installers' names and the update metadata's. */
const VERSION = flags.version ?? HOST_VERSION;
/** `owner/repo`, set by GitHub Actions. Local builds have no repository coordinates. */
const REPOSITORY = process.env.GITHUB_REPOSITORY || undefined;
const HOST_DIR = flags["host-dir"] === undefined ? undefined : resolve(flags["host-dir"]);

const PLATFORM = process.platform as DesktopPlatform;
const HOST_EXE = PLATFORM === "win32" ? ".exe" : "";
const REQUESTED_ARCHS = flags.arch?.length ? [...new Set(flags.arch)] : [process.arch];

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

const INSTALLER_TARGETS: Record<DesktopPlatform, string[]> = {
  darwin: ["dmg", "zip"],
  win32: ["nsis"],
  linux: ["AppImage", "deb"],
};

/** The version of the Electron the desktop package installed, which is the one the app is built on. */
function electronVersion(): string {
  const manifest = Bun.resolveSync("electron/package.json", join(ROOT, "packages/desktop"));
  return (require(manifest) as { version: string }).version;
}

/** The host binary an arch's app bundles: from `--host-dir` as it is, or built for this run. */
async function hostBinaryFor(arch: DesktopArch): Promise<string> {
  const name = hostBinaryName(PLATFORM, arch);
  if (HOST_DIR !== undefined) {
    const path = join(HOST_DIR, name);
    if (
      !(await stat(path).then(
        (s) => s.isFile(),
        () => false,
      ))
    ) {
      throw new Error(`--host-dir ${HOST_DIR} has no ${name}`);
    }
    return path;
  }
  const target = hostTarget(PLATFORM, arch);
  const host = Bun.spawn(["bun", "scripts/build-host.ts", target], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await host.exited) !== 0) throw new Error(`building the ${target} host failed`);
  return join(ROOT, "dist/host", name);
}

/** Stops, before anything is built or deleted, when a process runs from the folder that packaging would replace. */
function refuseWhileRunning(bundleDir: string): void {
  const running = processesUnder(bundleDir, processes());
  if (running.length > 0) throw new Error(refusal("package", bundleDir, running));
}

async function main(): Promise<void> {
  const archs = REQUESTED_ARCHS.map((a) => {
    if (!isDesktopArch(a)) throw new Error(`--arch ${a}: expected arm64 or x64`);
    return a;
  });
  const bundleDir = join(OUT, bundleDirName(PLATFORM, archs));
  refuseWhileRunning(bundleDir);
  const targets = INSTALLER_TARGETS[PLATFORM] as string[] | undefined;
  if (targets === undefined) throw new Error(`no installer is defined for ${process.platform}`);
  // Before anything is built: a CI build without repository coordinates fails here, not after the installers exist.
  const publish = updateProvider(REPOSITORY, inCi(process.env));
  const hostBinaries = new Map<DesktopArch, string>();
  for (const arch of archs) hostBinaries.set(arch, await hostBinaryFor(arch));
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
  // One staged copy per arch; electron-builder expands ${arch} per build. A downloaded release artifact has lost its
  // executable bit, so it is restored here (the copy is byte-identical otherwise). The browser is per arch too.
  for (const [arch, hostBinary] of hostBinaries) {
    const dir = join(STAGE, "host", arch);
    await mkdir(dir, { recursive: true });
    const resource = join(dir, `claudebot-host${HOST_EXE}`);
    await copyFile(hostBinary, resource);
    await chmod(resource, 0o755);
    await prepareBrowserBundle(join(STAGE, "browser", arch), arch);
  }

  for (const name of SIGNING_AND_PUBLISH_ENV) delete process.env[name];
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  try {
    const artifacts = await build({
      projectDir: appDir,
      targets: Platform.current().createTarget(targets, ...archs.map((a) => archFromString(a))),
      publish: "never",
      config: {
        appId: BUNDLE_ID,
        productName: APP_NAME,
        electronVersion: electronVersion(),
        asar: true,
        npmRebuild: false,
        directories: { output: bundleDir },
        extraResources: [
          {
            from: join(STAGE, "host", "${arch}", `claudebot-host${HOST_EXE}`),
            to: `claudebot-host${HOST_EXE}`,
          },
          { from: join(STAGE, "browser", "${arch}", BUNDLE_DIR), to: BUNDLE_DIR },
        ],
        publish,
        mac: { identity: null, notarize: false, category: "public.app-category.developer-tools" },
        nsis: { artifactName: "${productName}-Setup-${version}.${ext}" },
        // Named without an arch: only linux x64 is released, and `${arch}` would spell it x86_64 and amd64 per target.
        linux: {
          category: "Development",
          executableName: "claudebot",
          maintainer: APP_NAME,
          artifactName: "${productName}-${version}.${ext}",
        },
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
