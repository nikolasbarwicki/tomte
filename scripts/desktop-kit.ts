// The parts of desktop packaging and releasing that need no Electron: which installers a release ships, what they
// are called, where the host binary sits inside an unpacked app, where the app looks for updates, and the check that
// the host inside every app is the release's own binary. `package-desktop.ts` builds, `release.ts desktop` checks and
// collects (`.github/workflows/release.yml`).
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { HOST_BINARIES, sha256 } from "./release-kit.ts";

export const APP_NAME = "Claudebot";

export type DesktopPlatform = "darwin" | "win32" | "linux";
export type DesktopArch = "arm64" | "x64";

export const isDesktopArch = (name: string): name is DesktopArch =>
  name === "arm64" || name === "x64";

/**
 * The desktop installers a release ships. A host binary exists for every host target, but an installer only for these:
 * macOS on both CPUs, Windows and Linux on x64. linux-arm64 stays host-only, and the Windows arm64 app is not built.
 */
const SUPPORTED_DESKTOP: Record<DesktopPlatform, readonly DesktopArch[]> = {
  darwin: ["arm64", "x64"],
  win32: ["x64"],
  linux: ["x64"],
};

/** The host target an app for this OS and CPU bundles, as `scripts/build-host.ts` names it (`windows`, not `win32`). */
export function hostTarget(platform: DesktopPlatform, arch: DesktopArch): string {
  return `${platform === "win32" ? "windows" : platform}-${arch}`;
}

export function hostBinaryName(platform: DesktopPlatform, arch: DesktopArch): string {
  return `claudebot-host-${hostTarget(platform, arch)}${platform === "win32" ? ".exe" : ""}`;
}

/** Folder under `--out` that one packaging run writes; the arches are in the name, so a mac run for both is its own folder. */
export function bundleDirName(platform: DesktopPlatform, archs: readonly DesktopArch[]): string {
  return `${APP_NAME}-${platform}-${archs.join("-")}`;
}

/** Where electron-builder leaves the unpacked app for an arch: no suffix for x64, `-<arch>` otherwise (`mac-arm64`). */
function unpackedDir(platform: DesktopPlatform, arch: DesktopArch): string {
  if (platform === "darwin") return arch === "x64" ? "mac" : `mac-${arch}`;
  const prefix = platform === "win32" ? "win" : "linux";
  return arch === "x64" ? `${prefix}-unpacked` : `${prefix}-${arch}-unpacked`;
}

/** The bundled host in the unpacked app, relative to the bundle folder; `claudebot-host` is the extra resource's name. */
export function bundledHostPath(platform: DesktopPlatform, arch: DesktopArch): string {
  const dir = unpackedDir(platform, arch);
  return platform === "darwin"
    ? join(dir, `${APP_NAME}.app`, "Contents", "Resources", "claudebot-host")
    : join(dir, "resources", `claudebot-host${platform === "win32" ? ".exe" : ""}`);
}

/**
 * The files one OS contributes to a release: the installers and the update metadata electron-updater reads. electron-builder
 * names the x64 mac files without the arch (`Claudebot-1.0.0.dmg`, `Claudebot-1.0.0-mac.zip`) and updater's x64 mac lookup
 * relies on `arm64` being absent from them. Windows and Linux names are set in `package-desktop.ts`.
 */
export function desktopAssets(
  platform: DesktopPlatform,
  archs: readonly DesktopArch[],
  version: string,
): { installers: string[]; metadata: string } {
  const v = `${APP_NAME}-${version}`;
  const supported = SUPPORTED_DESKTOP[platform];
  const unsupported = archs.filter((a) => !supported.includes(a));
  if (unsupported.length > 0) {
    throw new Error(
      `no ${platform} installer is released for ${unsupported.join(", ")}; supported: ${supported.join(", ")}`,
    );
  }
  if (platform === "darwin") {
    return {
      installers: archs.flatMap((a) =>
        a === "arm64" ? [`${v}-arm64.dmg`, `${v}-arm64-mac.zip`] : [`${v}.dmg`, `${v}-mac.zip`],
      ),
      metadata: "latest-mac.yml",
    };
  }
  if (platform === "win32") {
    return { installers: [`${APP_NAME}-Setup-${version}.exe`], metadata: "latest.yml" };
  }
  return { installers: [`${v}.AppImage`, `${v}.deb`], metadata: "latest-linux.yml" };
}

/** Every file a complete release holds: the five host binaries, and for every supported OS its installers and metadata. */
export function releaseAssets(version: string): string[] {
  const desktop = (Object.keys(SUPPORTED_DESKTOP) as DesktopPlatform[]).flatMap((platform) => {
    const { installers, metadata } = desktopAssets(platform, SUPPORTED_DESKTOP[platform], version);
    return [...installers, metadata];
  });
  return [...HOST_BINARIES, ...desktop];
}

/** CI runners set `CI` (GitHub Actions: `true`); a local shell normally does not. */
export function inCi(env: Record<string, string | undefined>): boolean {
  return env.CI !== undefined && env.CI !== "" && env.CI !== "false" && env.CI !== "0";
}

/**
 * Where the app looks for updates: this repository's GitHub Releases. Without repository coordinates a local build gets
 * the placeholder host (reserved `.invalid`, never resolves) so the metadata stays well-formed; in CI that is an error,
 * so a release can never ship an app that updates from nowhere.
 */
export function updateProvider(repository: string | undefined, ci: boolean) {
  if (repository === undefined || repository === "") {
    if (ci) {
      throw new Error(
        "GITHUB_REPOSITORY (owner/repo) is not set in CI: refusing to bake the placeholder update provider into a release build",
      );
    }
    return { provider: "generic" as const, url: "https://updates.invalid/claudebot" };
  }
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repository);
  if (!match?.[1] || !match[2]) {
    throw new Error(`GITHUB_REPOSITORY "${repository}" is not owner/repo`);
  }
  return { provider: "github" as const, owner: match[1], repo: match[2] };
}

/** The host inside a mac zip, hashed; `unzip -p` is on every macOS and Linux image. */
async function hashZipMember(zip: string, member: string): Promise<string> {
  const unzip = Bun.spawn(["unzip", "-p", zip, member], { stdout: "pipe", stderr: "pipe" });
  const [bytes, stderr, code] = await Promise.all([
    new Response(unzip.stdout).arrayBuffer(),
    new Response(unzip.stderr).text(),
    unzip.exited,
  ]);
  if (code !== 0) throw new Error(`cannot read ${member} from ${zip}: ${stderr.trim()}`);
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

/** `version: 1.2.3` in electron-builder's update metadata (a top-level key, possibly quoted). */
function metadataVersion(text: string): string | undefined {
  return /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1];
}

export interface DesktopRelease {
  /** Folder one packaging run wrote (`<out>/Claudebot-<os>-<archs>`). */
  bundleDir: string;
  /** Folder holding the release's host binaries, named `claudebot-host-<os>-<arch>[.exe]`. */
  hostDir: string;
  /** Where the installers and metadata are copied. */
  outDir: string;
  platform: DesktopPlatform;
  archs: readonly DesktopArch[];
  version: string;
}

/**
 * Checks a packaging run against the release and collects what the release publishes. For every arch the host binary in
 * the unpacked app (and, on macOS, in the update zip) must hash the same as the release's own binary, and off Windows
 * it must be executable (an uploaded artifact loses its mode, so packaging has to restore it); the update metadata must
 * name `version`; every installer must exist. Then the installers, their blockmaps (when electron-builder wrote one)
 * and the metadata are copied into `outDir`, and nothing else from the bundle folder. Throws on the first failure.
 */
export async function collectDesktopRelease(r: DesktopRelease): Promise<string[]> {
  const { installers, metadata } = desktopAssets(r.platform, r.archs, r.version);
  const named = metadataVersion(await readFile(join(r.bundleDir, metadata), "utf8"));
  if (named !== r.version) {
    throw new Error(`${metadata} names version ${named ?? "(none)"}, the release is ${r.version}`);
  }
  for (const arch of r.archs) {
    const released = await sha256(join(r.hostDir, hostBinaryName(r.platform, arch)));
    const inApp = join(r.bundleDir, bundledHostPath(r.platform, arch));
    const bundled = await sha256(inApp);
    if (bundled !== released) {
      throw new Error(
        `${inApp} (${bundled}) is not the release's ${hostBinaryName(r.platform, arch)} (${released})`,
      );
    }
    if (r.platform !== "win32" && ((await stat(inApp)).mode & 0o111) === 0) {
      throw new Error(`${inApp} is not executable`);
    }
    if (r.platform === "darwin") {
      const zip = installers.find(
        (n) => n.endsWith("-mac.zip") && n.includes("arm64") === (arch === "arm64"),
      );
      if (zip === undefined) throw new Error(`no update zip is expected for ${arch}`);
      const member = join(`${APP_NAME}.app`, "Contents", "Resources", "claudebot-host");
      const inZip = await hashZipMember(join(r.bundleDir, zip), member);
      if (inZip !== released) {
        throw new Error(
          `${zip} holds a host (${inZip}) that is not the release's ${hostBinaryName(r.platform, arch)} (${released})`,
        );
      }
    }
  }
  await mkdir(r.outDir, { recursive: true });
  const collected: string[] = [];
  for (const name of [...installers, metadata, ...installers.map((n) => `${n}.blockmap`)]) {
    const from = join(r.bundleDir, name);
    const exists = await stat(from).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!exists) {
      if (name.endsWith(".blockmap")) continue;
      throw new Error(`${from} was not built`);
    }
    await copyFile(from, join(r.outDir, name));
    collected.push(name);
  }
  return collected;
}
