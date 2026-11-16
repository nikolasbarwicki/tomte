// What a signed, notarized macOS release must pass, as commands run through a {@link Runner}: the app (and the app inside
// the update zip), everything it bundles that runs (the host and the whole browser) and the DMG. `signing.ts verify` (CI)
// and `sign-local.ts` (the local route, docs/release/local-signing.md) both call these, so the two never check different
// things.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { BUNDLE_DIR } from "../packages/host/src/browser/engine.ts";
import { type BundleFiles, diskFiles } from "./bundle-files.ts";
import type { Runner } from "./command-runner.ts";
import { type DesktopArch, bundledAppPath, desktopAssets } from "./desktop-kit.ts";
import {
  checkSignedMac,
  parseCodesignDetails,
  SigningError,
  type SignedMacPart,
} from "./signing-kit.ts";

/** How a part of the browser is checked: `chrome` is deep (it nests the framework), `app` and `chrome` hold entitlements, `file` is signature and identity only. */
export type MacPartKind = "chrome" | "app" | "file";

/** The commands that check one part of the bundled browser, in the order they run: validity, identity, and (for `chrome` and `app`, not `file`) entitlements. */
export function macPartCommands(path: string, kind: MacPartKind) {
  return {
    signature: [
      "codesign",
      "--verify",
      ...(kind === "chrome" ? ["--deep"] : []),
      "--strict",
      "--verbose=2",
      path,
    ],
    details: ["codesign", "-dvv", path],
    entitlements: ["codesign", "-d", "--entitlements", ":-", path],
  };
}

const CHROME_APP = "Google Chrome for Testing.app";
const CHROME_FRAMEWORK = "Google Chrome for Testing Framework.framework";

/** Where the browser sits in an app: `browser-engine/` in Resources, the engine beside `chrome/chrome-mac-<arch>/` (browser-bundle.ts). */
function browserPaths(app: string, arch: DesktopArch) {
  const dir = join(app, "Contents", "Resources", BUNDLE_DIR);
  const chrome = join(dir, "chrome", `chrome-mac-${arch}`, CHROME_APP);
  return {
    dir,
    engine: join(dir, "agent-browser"),
    chrome,
    framework: join(chrome, "Contents", "Frameworks", CHROME_FRAMEWORK),
  };
}

export interface MacAppCommands {
  appSignature: string[];
  gatekeeper: string[];
  appStaple: string[];
  hostSignature: string[];
  appDetails: string[];
  hostDetails: string[];
  hostEntitlements: string[];
  engineSignature: string[];
  engineDetails: string[];
  chromeSignature: string[];
  chromeDetails: string[];
  chromeEntitlements: string[];
  frameworkSignature: string[];
  frameworkDetails: string[];
}

/**
 * The commands `verifyMacApp` runs on one app, in order; the local plan prints exactly these. After them it runs
 * {@link macPartCommands} on every Helper app, Helper executable and library it finds in the Chrome framework, which
 * cannot be listed before the bundle exists.
 */
export function macAppCommands(app: string, arch: DesktopArch): MacAppCommands {
  // The bundled host is signed by the same identity as the app.
  const host = join(app, "Contents", "Resources", "claudebot-host");
  const b = browserPaths(app, arch);
  const engine = macPartCommands(b.engine, "file");
  const chrome = macPartCommands(b.chrome, "chrome");
  const framework = macPartCommands(b.framework, "file");
  return {
    appSignature: ["codesign", "--verify", "--deep", "--strict", "--verbose=2", app],
    gatekeeper: ["spctl", "--assess", "--type", "execute", "--verbose=4", app],
    appStaple: ["xcrun", "stapler", "validate", app],
    hostSignature: ["codesign", "--verify", "--strict", "--verbose=2", host],
    appDetails: ["codesign", "-dvv", app],
    hostDetails: ["codesign", "-dvv", host],
    hostEntitlements: ["codesign", "-d", "--entitlements", ":-", host],
    engineSignature: engine.signature,
    engineDetails: engine.details,
    chromeSignature: chrome.signature,
    chromeDetails: chrome.details,
    chromeEntitlements: chrome.entitlements,
    frameworkSignature: framework.signature,
    frameworkDetails: framework.details,
  };
}

export interface DmgCommands {
  gatekeeper: string[];
  staple: string[];
  signature: string[];
  details: string[];
}

/** The commands `verifyDmg` runs on a DMG, in order. */
export function dmgCommands(dmg: string): DmgCommands {
  return {
    gatekeeper: ["spctl", "-a", "-t", "open", "--context", "context:primary-signature", "-vv", dmg],
    staple: ["xcrun", "stapler", "validate", dmg],
    signature: ["codesign", "--verify", "--strict", "--verbose=2", dmg],
    details: ["codesign", "-dvv", dmg],
  };
}

type Log = (line: string) => void;

interface BrowserPart {
  path: string;
  kind: MacPartKind;
}

/** Every `.dylib` under `dir`, however deep (Widevine's sits three folders down). */
async function dylibsUnder(files: BundleFiles, dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const e of await files.list(dir)) {
    const path = join(dir, e.name);
    if (e.kind === "dir") found.push(...(await dylibsUnder(files, path)));
    else if (e.name.endsWith(".dylib")) found.push(path);
  }
  return found;
}

/**
 * The browser of one app: the engine, Chrome for Testing and its framework (a signed release without them is broken, so
 * a missing one throws), then, found in the framework's `Versions/<version>/` folders, every Helper app (`Helpers/*.app`),
 * every other file in `Helpers/` (the crash handler and loaders) and every library under `Libraries/`. Helper names are
 * not listed here: Chrome renames them between releases (the Aperitif helpers are recent).
 */
async function browserParts(
  files: BundleFiles,
  app: string,
  arch: DesktopArch,
): Promise<BrowserPart[]> {
  const b = browserPaths(app, arch);
  const missing: string[] = [];
  for (const path of [b.dir, b.engine, b.chrome, b.framework]) {
    if (!(await files.exists(path))) missing.push(path);
  }
  if (missing.length > 0) {
    throw new SigningError(
      `${app}: the bundled browser is incomplete, missing:\n- ${missing.join("\n- ")}`,
    );
  }
  const parts: BrowserPart[] = [
    { path: b.engine, kind: "file" },
    { path: b.chrome, kind: "chrome" },
    { path: b.framework, kind: "file" },
  ];
  const versions = join(b.framework, "Versions");
  const found: BrowserPart[] = [];
  for (const v of await files.list(versions)) {
    // `Current` is a symlink to a version folder, listed as a file, so each part is found once under the real name.
    if (v.kind !== "dir") continue;
    const helpers = join(versions, v.name, "Helpers");
    if (!(await files.exists(helpers))) {
      throw new SigningError(`${app}: the Chrome framework has no Helpers folder: ${helpers}`);
    }
    for (const h of await files.list(helpers)) {
      const path = join(helpers, h.name);
      if (h.kind === "dir" && h.name.endsWith(".app")) found.push({ path, kind: "app" });
      else if (h.kind === "file") found.push({ path, kind: "file" });
    }
    for (const lib of await dylibsUnder(files, join(versions, v.name, "Libraries"))) {
      found.push({ path: lib, kind: "file" });
    }
  }
  if (!found.some((p) => p.kind === "app")) {
    throw new SigningError(`${app}: the Chrome framework holds no Helper app under ${versions}`);
  }
  return [...parts, ...found];
}

/**
 * One mac app, the host and the whole browser inside it: the app valid, notarized and stapled; the host and every
 * browser part valid, signed by the app's identity, with the entitlements the plist grants where they apply. Returns the
 * app's Team ID.
 */
export async function verifyMacApp(
  run: Runner,
  app: string,
  arch: DesktopArch,
  log: Log = console.log,
  files: BundleFiles = diskFiles,
): Promise<string> {
  const parts = await browserParts(files, app, arch);
  const c = macAppCommands(app, arch);
  await run(c.appSignature);
  await run(c.gatekeeper);
  await run(c.appStaple);
  await run(c.hostSignature);
  const appInfo = parseCodesignDetails((await run(c.appDetails)).stderr);
  const hostInfo = parseCodesignDetails((await run(c.hostDetails)).stderr);
  const entitlements = (await run(c.hostEntitlements)).stdout;
  const resources = join(app, "Contents", "Resources");
  const checked: SignedMacPart[] = [];
  for (const { path, kind } of parts) {
    const part = macPartCommands(path, kind);
    await run(part.signature);
    const info = parseCodesignDetails((await run(part.details)).stderr);
    const label = relative(resources, path);
    checked.push(
      kind !== "file"
        ? { label, info, entitlements: (await run(part.entitlements)).stdout }
        : { label, info },
    );
  }
  const problems = checkSignedMac(
    { label: "the app", info: appInfo },
    { label: "the host", info: hostInfo },
    entitlements,
    checked,
  );
  if (problems.length > 0) throw new SigningError(`${app}:\n- ${problems.join("\n- ")}`);
  log(
    `ok ${app} (Team ID ${appInfo.teamId}, host signed by ${hostInfo.authorities[0]}, ${parts.length} browser parts)`,
  );
  return appInfo.teamId as string;
}

/** The app of every arch in a packaging run, and the app inside each update zip (what electron-updater applies must hold up on its own). Returns each app's Team ID. */
export async function verifyMacBundle(
  run: Runner,
  bundleDir: string,
  version: string,
  archs: readonly DesktopArch[],
  log: Log = console.log,
  files: BundleFiles = diskFiles,
): Promise<string[]> {
  const tmp = await mkdtemp(join(tmpdir(), "claudebot-verify-"));
  const teams: string[] = [];
  try {
    for (const arch of archs) {
      teams.push(
        await verifyMacApp(run, join(bundleDir, bundledAppPath("darwin", arch)), arch, log, files),
      );
      const zip = desktopAssets("darwin", [arch], version).installers.find((n) =>
        n.endsWith("-mac.zip"),
      );
      if (zip === undefined) throw new Error(`no update zip is expected for ${arch}`);
      const out = join(tmp, arch);
      await run(["ditto", "-x", "-k", join(bundleDir, zip), out]);
      teams.push(await verifyMacApp(run, join(out, "Claudebot.app"), arch, log, files));
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return teams;
}

/** A DMG: Gatekeeper accepts it as a primary-signature disk image, its ticket is stapled, its signature is valid and its signer is the app's team. */
export async function verifyDmg(
  run: Runner,
  dmg: string,
  teamId: string,
  log: Log = console.log,
): Promise<void> {
  const c = dmgCommands(dmg);
  await run(c.gatekeeper);
  await run(c.staple);
  await run(c.signature);
  const info = parseCodesignDetails((await run(c.details)).stderr);
  const problems: string[] = [];
  if (info.adhoc) problems.push("the DMG is signed ad hoc");
  if (!info.authorities.some((a) => a.startsWith("Developer ID Application:"))) {
    problems.push("the DMG is not signed by a Developer ID Application certificate");
  }
  if (!info.secureTimestamp) problems.push("the DMG's signature has no secure timestamp");
  if (info.teamId !== teamId) {
    problems.push(`the DMG's Team ID is ${info.teamId ?? "(none)"}, the app's is ${teamId}`);
  }
  if (problems.length > 0) throw new SigningError(`${dmg}:\n- ${problems.join("\n- ")}`);
  log(`ok ${dmg} (Team ID ${teamId})`);
}
