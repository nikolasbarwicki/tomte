import { chmod, copyFile, cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

// Packages the desktop app for this machine, unsigned and unnotarized, into dist/desktop/ (gitignored):
//   bun run package:desktop [--out <dir>] [--version <semver>] [--arch <arm64|x64>]... [--host-dir <dir>] [--update-url <http://127.0.0.1:port>]
// Bundles the main process and runs electron-builder with asar on. It writes, into <out>/Claudebot-<os>-<archs>/, the
// installers (macOS: dmg and zip; Windows: NSIS; Linux: AppImage and deb), the update metadata electron-updater reads
// (latest-mac.yml, latest.yml, latest-linux.yml) and the unpacked app (mac-<arch>/Claudebot.app, win-unpacked/,
// linux-unpacked/). Nothing is published, and nothing is signed unless `--sign` is given (below).
// The host binary goes in as the extra resource `claudebot-host`, next to the app's other resources, and the browser
// (scripts/browser-bundle.ts, for the arch being packaged) as `browser-engine` beside it, where the host looks for it.
// By default each arch's host is built for this run into dist/host; `--host-dir` bundles the already-built binaries in
// <dir> instead (named claudebot-host-<os>-<arch>[.exe], as build:host and the release workflow's artifacts are) and
// builds none.
// `--arch` (repeatable, default this machine's) packages several CPUs in one run, which is how the macOS release gets one
// latest-mac.yml for both arm64 and x64 (electron-builder writes one file per OS and run). `--version` defaults to the host's VERSION.
// `--update-url` bakes a loopback `http` feed into app-update.yml instead of GitHub Releases, for verifying auto-update on this machine; it is refused in CI.
// It refuses, before building or deleting anything, when a process is running from the folder it would replace.
// `--sign` (or CLAUDEBOT_REQUIRE_SIGNING=true) signs this OS's app with the certificates in the environment (names in
// scripts/signing-kit.ts SIGNING_SECRETS): macOS Developer ID, hardened runtime and notarized, Windows Authenticode. It
// exits before building when one of them is missing. Without it the build is unsigned, whatever the environment holds,
// and no keychain identity is ever looked up. The bundled host must already be signed (`scripts/signing.ts sign-host`).
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
import {
  packagingSigning,
  MAC_ENTITLEMENTS,
  SIGNING_SECRETS,
  TIMESTAMP_URL,
} from "./signing-kit.ts";

const ROOT = join(import.meta.dir, "..");
const { values: flags } = parseArgs({
  options: {
    out: { type: "string" },
    version: { type: "string" },
    arch: { type: "string", multiple: true },
    "host-dir": { type: "string" },
    sign: { type: "boolean" },
    "update-url": { type: "string" },
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
  "CSC_KEYCHAIN",
  "CSC_INSTALLER_LINK",
  "CSC_INSTALLER_KEY_PASSWORD",
  "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE",
];

const MAC_CATEGORY = "public.app-category.developer-tools";
/** Unsigned and unnotarized, and no identity is looked up: the local and the default release build. */
const UNSIGNED_MAC = { identity: null, notarize: false, category: MAC_CATEGORY };
/**
 * Developer ID signed with the hardened runtime and notarized (notarization staples the ticket), from the one
 * certificate in CSC_LINK. Everything Mach-O in the app is signed by electron-builder with the same entitlements file,
 * except the host: it arrives already signed by the same certificate (`signing.ts sign-host`, the host job), and
 * re-signing it would change the bytes `release.ts desktop` compares to the release's own binary.
 */
const SIGNED_MAC = {
  category: MAC_CATEGORY,
  hardenedRuntime: true,
  entitlements: MAC_ENTITLEMENTS,
  entitlementsInherit: MAC_ENTITLEMENTS,
  notarize: true,
  signIgnore: ["/Contents/Resources/claudebot-host$"],
};
/**
 * The app, its uninstaller and the installer are signed with the PFX in WIN_CSC_LINK, SHA-256 only and timestamped.
 * The host's exe is not: `!` excludes it from electron-builder's signing of extra resources; it arrives signed (see above).
 */
const SIGNED_WIN = {
  signtoolOptions: {
    signingHashAlgorithms: ["sha256" as const],
    rfc3161TimeStampServer: TIMESTAMP_URL,
  },
  signExts: ["!claudebot-host.exe"],
};

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
  const publish = updateProvider(REPOSITORY, inCi(process.env), flags["update-url"]);
  // Also before anything is built: a signed run without all of this OS's secrets, or a required one without --sign,
  // fails here, never after producing an unsigned installer.
  const signing = packagingSigning(PLATFORM, process.env, flags.sign ?? false);
  console.log(
    signing.signed
      ? `signing: ${signing.platform}, signed`
      : `signing: unsigned (${signing.reason})`,
  );
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

  // Credentials come from the environment only when this run signs; every run starts from an environment without them.
  const credentials = signing.signed
    ? Object.fromEntries(SIGNING_SECRETS[signing.platform].map((n) => [n, process.env[n] ?? ""]))
    : {};
  for (const name of [...SIGNING_AND_PUBLISH_ENV, ...Object.values(SIGNING_SECRETS).flat()]) {
    delete process.env[name];
  }
  // Unsigned: no identity is ever looked up. Signed: electron-builder imports the certificate into a keychain of its
  // own (CSC_LINK) and looks only there.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = signing.signed ? "true" : "false";
  let secretsDir: string | undefined;
  try {
    if (signing.signed && signing.platform === "darwin") {
      secretsDir = await mkdtemp(join(tmpdir(), "claudebot-notary-"));
      const key = join(secretsDir, "AuthKey.p8");
      await writeFile(key, credentials.APPLE_API_KEY_P8 ?? "", { mode: 0o600 });
      Object.assign(process.env, {
        CSC_LINK: credentials.MACOS_CERTIFICATE_P12,
        CSC_KEY_PASSWORD: credentials.MACOS_CERTIFICATE_PASSWORD,
        APPLE_API_KEY: key,
        APPLE_API_KEY_ID: credentials.APPLE_API_KEY_ID,
        APPLE_API_ISSUER: credentials.APPLE_API_ISSUER,
      });
    } else if (signing.signed) {
      Object.assign(process.env, {
        WIN_CSC_LINK: credentials.WINDOWS_CERTIFICATE_PFX,
        WIN_CSC_KEY_PASSWORD: credentials.WINDOWS_CERTIFICATE_PASSWORD,
      });
    }
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
        mac: signing.signed && signing.platform === "darwin" ? SIGNED_MAC : UNSIGNED_MAC,
        ...(signing.signed && signing.platform === "win32" ? { win: SIGNED_WIN } : {}),
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
    if (secretsDir !== undefined) await rm(secretsDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
