// What a signed, notarized macOS release must pass, as commands run through a {@link Runner}: the app (and the app inside
// the update zip) and the DMG. `signing.ts verify` (CI) and `sign-local.ts` (the local route, docs/release/local-signing.md)
// both call these, so the two never check different things.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Runner } from "./command-runner.ts";
import { type DesktopArch, bundledAppPath, desktopAssets } from "./desktop-kit.ts";
import { checkSignedMac, parseCodesignDetails, SigningError } from "./signing-kit.ts";

export interface MacAppCommands {
  appSignature: string[];
  gatekeeper: string[];
  appStaple: string[];
  hostSignature: string[];
  appDetails: string[];
  hostDetails: string[];
  hostEntitlements: string[];
}

/** The commands `verifyMacApp` runs on one app, in order; the local plan prints exactly these. */
export function macAppCommands(app: string): MacAppCommands {
  // The bundled host is signed by the same identity as the app.
  const host = join(app, "Contents", "Resources", "claudebot-host");
  return {
    appSignature: ["codesign", "--verify", "--deep", "--strict", "--verbose=2", app],
    gatekeeper: ["spctl", "--assess", "--type", "execute", "--verbose=4", app],
    appStaple: ["xcrun", "stapler", "validate", app],
    hostSignature: ["codesign", "--verify", "--strict", "--verbose=2", host],
    appDetails: ["codesign", "-dvv", app],
    hostDetails: ["codesign", "-dvv", host],
    hostEntitlements: ["codesign", "-d", "--entitlements", ":-", host],
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

/** One mac app and the host inside it: valid, notarized, stapled, and the host signed by the app's identity. Returns the app's Team ID. */
export async function verifyMacApp(
  run: Runner,
  app: string,
  log: Log = console.log,
): Promise<string> {
  const c = macAppCommands(app);
  await run(c.appSignature);
  await run(c.gatekeeper);
  await run(c.appStaple);
  await run(c.hostSignature);
  const appInfo = parseCodesignDetails((await run(c.appDetails)).stderr);
  const hostInfo = parseCodesignDetails((await run(c.hostDetails)).stderr);
  const entitlements = (await run(c.hostEntitlements)).stdout;
  const problems = checkSignedMac(
    { label: "the app", info: appInfo },
    { label: "the host", info: hostInfo },
    entitlements,
  );
  if (problems.length > 0) throw new SigningError(`${app}:\n- ${problems.join("\n- ")}`);
  log(`ok ${app} (Team ID ${appInfo.teamId}, host signed by ${hostInfo.authorities[0]})`);
  return appInfo.teamId as string;
}

/** The app of every arch in a packaging run, and the app inside each update zip (what electron-updater applies must hold up on its own). Returns each app's Team ID. */
export async function verifyMacBundle(
  run: Runner,
  bundleDir: string,
  version: string,
  archs: readonly DesktopArch[],
  log: Log = console.log,
): Promise<string[]> {
  const tmp = await mkdtemp(join(tmpdir(), "claudebot-verify-"));
  const teams: string[] = [];
  try {
    for (const arch of archs) {
      teams.push(await verifyMacApp(run, join(bundleDir, bundledAppPath("darwin", arch)), log));
      const zip = desktopAssets("darwin", [arch], version).installers.find((n) =>
        n.endsWith("-mac.zip"),
      );
      if (zip === undefined) throw new Error(`no update zip is expected for ${arch}`);
      const out = join(tmp, arch);
      await run(["ditto", "-x", "-k", join(bundleDir, zip), out]);
      teams.push(await verifyMacApp(run, join(out, "Claudebot.app"), log));
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
