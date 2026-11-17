// The parts of release signing that need no certificate: which signing secrets a platform needs, whether a release is
// signed, whether a missing secret fails it, and what a signed build must look like. `package-desktop.ts` and
// `signing.ts` do the work, `.github/workflows/release.yml` wires the secrets in (see AGENTS.md, "Releasing").
//
// Policy. A platform's signing secrets are all set (signed), all unset (unsigned, unless TOMTE_REQUIRE_SIGNING=true,
// which makes it an error) or partly set (always an error: a half-configured release must not quietly ship unsigned).
// The values never pass through this file's results, only their names do, so nothing here can print a secret.

import { join } from "node:path";

export type SigningPlatform = "darwin" | "win32";

/** Repository variable (`vars.TOMTE_REQUIRE_SIGNING`) that turns a missing secret into a failed release. */
const REQUIRE_SIGNING_VAR = "TOMTE_REQUIRE_SIGNING";

/** The entitlements file for everything the release signs on macOS (Electron app, helpers, the bundled host and the bundled browser). */
export const MAC_ENTITLEMENTS = join(import.meta.dir, "entitlements.mac.plist");

/**
 * Secret names, one set per platform, all required. Mac: the Developer ID Application certificate as a base64 .p12
 * and its password, and an App Store Connect API key (the .p8's text, its key id and the issuer id) for notarization.
 * Windows: a code signing certificate as a base64 .pfx and its password.
 */
export const SIGNING_SECRETS: Record<SigningPlatform, readonly string[]> = {
  darwin: [
    "MACOS_CERTIFICATE_P12",
    "MACOS_CERTIFICATE_PASSWORD",
    "APPLE_API_KEY_P8",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ],
  win32: ["WINDOWS_CERTIFICATE_PFX", "WINDOWS_CERTIFICATE_PASSWORD"],
};

/** RFC 3161 timestamp server for Windows signatures; a signature outlives the certificate only with a timestamp. */
export const TIMESTAMP_URL = "http://timestamp.digicert.com";

/**
 * The app, its uninstaller and the installer are signed with the PFX in WIN_CSC_LINK, SHA-256 only and timestamped.
 * `signExts` is electron-builder's `shouldSignFile`: every pattern is an `endsWith` on the full path, a positive match
 * wins over a `!` one, and a file that matches neither is signed when it is an `.exe`. So:
 * - `.dll` signs libraries too, which it never does by default. They are the bundled Chrome's (`chrome.dll`, `libEGL.dll`,
 *   ...), which the extra-resource copy signs file by file, and also the Electron app's own top-level DLLs and any in
 *   `app.asar.unpacked`, which `signApp` signs the same way. Every `.exe` stays signed by default, the engine and Chrome's
 *   among them.
 * - `!tomte-host.exe` keeps the host out: it arrives signed (`signing.ts sign-host`) and a second signature would break the byte
 *   identity `release.ts desktop` checks. Never add a positive `.exe` pattern, it would beat this one.
 * - Chrome for Testing's one third-party DLL, `D3DCompiler_47.dll`, carries Microsoft's signature in the pinned zip and
 *   cannot be excluded (a `!` pattern loses to `.dll`), so it ends up with ours, replacing Microsoft's (nothing in Chrome is
 *   known to check that DLL's signer; unobserved), and `signing.ts verify` requires one certificate on every file. Every other `.exe` and
 *   `.dll` in the zip is unsigned.
 * electron-builder only warns when it fails to sign one of these files, so `signing.ts verify` is what fails the release.
 */
export const SIGNED_WIN = {
  signtoolOptions: {
    signingHashAlgorithms: ["sha256" as const],
    rfc3161TimeStampServer: TIMESTAMP_URL,
  },
  signExts: [".dll", "!tomte-host.exe"],
};

/** A signing configuration that cannot proceed: required but missing, or only partly set. */
export class SigningError extends Error {}

export type SigningDecision =
  | { signed: true; platform: SigningPlatform }
  | { signed: false; platform: SigningPlatform | "linux"; reason: string };

type Env = Readonly<Record<string, string | undefined>>;

/** True only for the exact value `true`; anything else (unset, empty, `false`, `1`) leaves signing optional. */
export function signingRequired(env: Env): boolean {
  return (env[REQUIRE_SIGNING_VAR] ?? "").trim() === "true";
}

/**
 * Whether a platform's release is signed, from the secrets in `env`. Throws {@link SigningError} when only some of the
 * secrets are set, or when none are set and `required`.
 */
export function planSigning(
  platform: SigningPlatform,
  env: Env,
  required: boolean,
): SigningDecision {
  const names = SIGNING_SECRETS[platform];
  const missing = names.filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length === 0) return { signed: true, platform };
  if (missing.length < names.length) {
    throw new SigningError(
      `${platform} signing is partly configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set; set all of ${names.join(", ")} or none`,
    );
  }
  if (required) {
    throw new SigningError(
      `${platform} signing is required (${REQUIRE_SIGNING_VAR}=true or --sign) but none of its secrets are set (${names.join(", ")}); the build would be unsigned`,
    );
  }
  return {
    signed: false,
    platform,
    reason: `no ${platform} signing secrets are set (${names.join(", ")})`,
  };
}

/**
 * The decision for one packaging run. Linux packages are never signed, and a signing requirement does not apply to them.
 * Without `--sign` (or the requirement) a run is unsigned whatever the environment holds, so a developer's leftover
 * certificate variables never sign a local build; with it, the platform's secrets must all be set.
 */
export function packagingSigning(
  platform: SigningPlatform | "linux",
  env: Env,
  sign: boolean,
): SigningDecision {
  if (platform === "linux") {
    return { signed: false, platform, reason: "Linux packages are not signed" };
  }
  if (!sign && !signingRequired(env)) {
    return { signed: false, platform, reason: "signing was not requested (--sign)" };
  }
  return planSigning(platform, env, true);
}

/** Markdown for the job summary: one line per platform, loud when a release goes out unsigned. */
export function signingSummary(decisions: readonly SigningDecision[], required: boolean): string {
  const lines = decisions.map((d) =>
    d.signed ? `- ${d.platform}: signed` : `- ${d.platform}: UNSIGNED (${d.reason})`,
  );
  const unsigned = decisions.some((d) => !d.signed);
  const head = unsigned
    ? "### Signing: this release is NOT fully signed"
    : "### Signing: macOS and Windows are signed";
  const policy = required
    ? `${REQUIRE_SIGNING_VAR}=true: a missing secret fails the release.`
    : `${REQUIRE_SIGNING_VAR} is not \`true\`: a missing secret leaves that platform unsigned.`;
  return `${head}\n\n${lines.join("\n")}\n\n${policy}\n`;
}

/** What `codesign -dvv` says about a signed Mach-O or bundle. */
export interface CodesignInfo {
  authorities: string[];
  teamId: string | undefined;
  hardenedRuntime: boolean;
  secureTimestamp: boolean;
  adhoc: boolean;
}

/** Reads `codesign -dvv` output (it prints on stderr). `TeamIdentifier=not set` means no team. */
export function parseCodesignDetails(text: string): CodesignInfo {
  const authorities: string[] = [];
  let teamId: string | undefined;
  let hardenedRuntime = false;
  let secureTimestamp = false;
  let adhoc = false;
  for (const line of text.split("\n")) {
    const authority = /^Authority=(.+)$/.exec(line)?.[1];
    if (authority !== undefined) authorities.push(authority.trim());
    const team = /^TeamIdentifier=(.+)$/.exec(line)?.[1]?.trim();
    if (team !== undefined && team !== "not set") teamId = team;
    if (/^CodeDirectory .*\bflags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(line)) hardenedRuntime = true;
    if (line.startsWith("Timestamp=")) secureTimestamp = true;
    if (/^Signature=adhoc\b/.test(line)) adhoc = true;
  }
  return { authorities, teamId, hardenedRuntime, secureTimestamp, adhoc };
}

/** True when an entitlements plist (`codesign -d --entitlements :-`) sets `key` to true. */
export function hasEntitlement(plist: string, key: string): boolean {
  return new RegExp(`<key>${key.replaceAll(".", "\\.")}</key>\\s*<true\\s*/>`).test(plist);
}

export interface SignedMacCode {
  /** Shown in messages: the app or the host. */
  label: string;
  info: CodesignInfo;
}

/** One Mach-O or bundle inside the bundled browser: its signature, and its entitlements when it must hold them. */
export interface SignedMacPart extends SignedMacCode {
  /** `codesign -d --entitlements :-` output; present for the code that runs (Chrome and its Helper apps), absent for libraries and the engine. */
  entitlements?: string;
}

/**
 * The entitlements `scripts/entitlements.mac.plist` grants, and so what every signed executable that carries them must
 * hold: the host (Bun's JavaScript engine JITs) and the browser's Chrome and Helper apps (V8 JITs; and Chrome loads
 * Google-signed libraries, which library validation would refuse once Chrome is re-signed under our Team ID). Keep this
 * list and the plist in step.
 */
const MAC_ENTITLEMENT_KEYS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
] as const;

/**
 * What a signed macOS app must look like: the app, the bundled host and every part of the bundled browser (the engine,
 * Chrome for Testing, its framework, Helper apps and libraries) are each signed with a Developer ID Application
 * certificate (not ad-hoc), the hardened runtime and a secure timestamp (both required to notarize), and all by the same
 * certificate, so the Team IDs and the leaf authority agree. The host and the parts that carry entitlements must hold
 * {@link MAC_ENTITLEMENT_KEYS}. A bundle with no browser parts is a problem: a signed release without its browser is
 * broken. Returns the problems, empty when fine.
 */
export function checkSignedMac(
  app: SignedMacCode,
  host: SignedMacCode,
  hostEntitlements: string,
  browser: readonly SignedMacPart[],
): string[] {
  const problems: string[] = [];
  if (browser.length === 0) problems.push("the bundle has no browser parts to check");
  const others = [host, ...browser];
  for (const { label, info } of [app, ...others]) {
    if (info.adhoc) problems.push(`${label} is ad-hoc signed`);
    if (!info.authorities[0]?.startsWith("Developer ID Application:")) {
      problems.push(
        `${label} is not signed with a Developer ID Application certificate (authority: ${info.authorities[0] ?? "none"})`,
      );
    }
    if (info.teamId === undefined) problems.push(`${label} has no Team ID`);
    if (!info.hardenedRuntime) problems.push(`${label} does not have the hardened runtime`);
    if (!info.secureTimestamp) problems.push(`${label} has no secure timestamp`);
  }
  for (const { label, info } of others) {
    if (app.info.teamId !== info.teamId) {
      problems.push(
        `${label}'s Team ID (${info.teamId ?? "none"}) differs from the app's (${app.info.teamId ?? "none"})`,
      );
    }
    if (app.info.authorities[0] !== info.authorities[0]) {
      problems.push(
        `${label} is signed by "${info.authorities[0] ?? "none"}", the app by "${app.info.authorities[0] ?? "none"}"`,
      );
    }
  }
  const held: [string, string][] = [[host.label, hostEntitlements]];
  for (const part of browser) {
    if (part.entitlements !== undefined) held.push([part.label, part.entitlements]);
  }
  for (const [label, entitlements] of held) {
    for (const key of MAC_ENTITLEMENT_KEYS) {
      if (!hasEntitlement(entitlements, key))
        problems.push(`${label} lacks the ${key} entitlement`);
    }
  }
  return problems;
}

export interface DeveloperIdIdentity {
  /** SHA-1 of the certificate; `codesign --sign` takes it, so a name that matches twice cannot be picked wrongly. */
  hash: string;
  name: string;
  teamId: string;
}

/**
 * The one Developer ID Application identity in `security find-identity -v -p codesigning` output. Throws when the
 * certificate holds none, or several (the app and the host must be signed by the same one).
 */
export function parseDeveloperIdIdentity(output: string): DeveloperIdIdentity {
  const found: DeveloperIdIdentity[] = [];
  for (const line of output.split("\n")) {
    const m =
      /^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: .+ \(([A-Z0-9]{10})\))"/.exec(line);
    if (m?.[1] && m[2] && m[3]) found.push({ hash: m[1], name: m[2], teamId: m[3] });
  }
  const [only, ...rest] = found;
  if (only === undefined) {
    throw new SigningError("the certificate holds no valid Developer ID Application identity");
  }
  if (rest.length > 0) {
    throw new SigningError(
      `the certificate holds ${found.length} Developer ID Application identities (${found.map((f) => f.name).join("; ")}); it must hold exactly one`,
    );
  }
  return only;
}

/** One file's Authenticode state, as `signing.ts` prints it from PowerShell's `Get-AuthenticodeSignature`. */
export interface AuthenticodeRecord {
  path: string;
  status: string;
  thumbprint: string;
  timestamped: boolean;
}

/** Reads lines of `path|status|thumbprint|timestamped` (the path is whatever precedes the last three bars). */
export function parseAuthenticodeLines(text: string): AuthenticodeRecord[] {
  const records: AuthenticodeRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split("|");
    if (parts.length < 4) throw new SigningError(`unreadable Authenticode line: ${trimmed}`);
    const [timestamped, thumbprint, status] = [parts.pop(), parts.pop(), parts.pop()];
    records.push({
      path: parts.join("|"),
      status: status ?? "",
      thumbprint: thumbprint ?? "",
      timestamped: timestamped === "True",
    });
  }
  return records;
}

/**
 * What the signed Windows files must look like: each has a valid, timestamped signature and all carry the same
 * certificate (the installer, the app and the bundled host are signed by one identity). Returns the problems.
 */
export function checkSignedWindows(records: readonly AuthenticodeRecord[]): string[] {
  const problems: string[] = [];
  if (records.length === 0) return ["no signed Windows files were checked"];
  for (const r of records) {
    if (r.status !== "Valid")
      problems.push(`${r.path}: signature status is ${r.status || "unknown"}`);
    if (r.thumbprint === "") problems.push(`${r.path}: no signing certificate`);
    if (!r.timestamped) problems.push(`${r.path}: no timestamp`);
  }
  const thumbprints = new Set(records.map((r) => r.thumbprint));
  if (thumbprints.size > 1) {
    problems.push(`the files are signed by ${thumbprints.size} different certificates`);
  }
  return problems;
}

/**
 * The local route's way to sign (`scripts/sign-local.ts`, docs/release/local-signing.md): a keychain file and one
 * identity in it chosen by SHA-1 hash, and who notarizes. The credentials themselves stay where `sign-local.ts` keeps
 * them; here are only a keychain path, a hash, and either the App Store Connect API key under the names electron-builder
 * reads (`p8`) or the name of a saved `asc` profile (`asc`, notarized by `asc-notary.ts` instead of electron-builder).
 */
export interface LocalMacSigning {
  keychain: string;
  /** SHA-1 of the Developer ID Application certificate, 40 upper-case hex digits (as `security find-identity` prints it). */
  identity: string;
  notary:
    | { kind: "p8"; key: string; keyId: string; issuer: string }
    | { kind: "asc"; profile: string; bin: string; record: string };
}

/** The flags of `package-desktop.ts` that request the local route. */
export interface LocalMacFlags {
  keychain: string | undefined;
  identity: string | undefined;
  /** `p8` (the default) or `asc`. */
  notary: string | undefined;
  ascProfile: string | undefined;
  ascBin: string | undefined;
  /** Where the asc backend leaves the app's submission as JSON. */
  notaryRecord: string | undefined;
}

/**
 * The local signing request of one packaging run, or `undefined` when neither `--local-keychain` nor `--local-identity`
 * is given (the CI path). Throws {@link SigningError} for anything that would make a half-local, half-CI run: one flag
 * without the other, no `--sign`, a platform other than macOS, a CI environment, a relative keychain path, an identity
 * that is not a SHA-1, and, per backend: for `p8` a notarization key that is not wholly named in `APPLE_API_KEY`,
 * `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` or any asc flag; for `asc` a missing profile, binary or record path, or a
 * relative one.
 */
export function localMacSigning(
  flags: LocalMacFlags,
  env: Env,
  where: { platform: SigningPlatform | "linux"; sign: boolean; ci: boolean },
): LocalMacSigning | undefined {
  if (flags.keychain === undefined && flags.identity === undefined) return undefined;
  if (flags.keychain === undefined || flags.identity === undefined) {
    throw new SigningError("--local-keychain and --local-identity go together");
  }
  if (!where.sign) throw new SigningError("--local-keychain and --local-identity need --sign");
  if (where.platform !== "darwin") throw new SigningError("local keychain signing is macOS only");
  if (where.ci) {
    throw new SigningError("local keychain signing is for a developer machine, not CI");
  }
  if (!flags.keychain.startsWith("/")) {
    throw new SigningError("--local-keychain must be an absolute path");
  }
  if (!/^[0-9A-F]{40}$/.test(flags.identity)) {
    throw new SigningError(
      "--local-identity must be a certificate's SHA-1 (40 upper-case hex digits)",
    );
  }
  const base = { keychain: flags.keychain, identity: flags.identity };
  const ascFlags = [flags.ascProfile, flags.ascBin, flags.notaryRecord];
  if (flags.notary === "asc") {
    const [profile, bin, record] = ascFlags;
    if (!profile || !bin || !record) {
      throw new SigningError(
        "--local-notary asc needs --local-asc-profile, --local-asc-bin and --local-notary-record",
      );
    }
    if (!bin.startsWith("/") || !record.startsWith("/")) {
      throw new SigningError("--local-asc-bin and --local-notary-record must be absolute paths");
    }
    return { ...base, notary: { kind: "asc", profile, bin, record } };
  }
  if (flags.notary !== undefined && flags.notary !== "p8") {
    throw new SigningError(`--local-notary ${flags.notary}: expected p8 or asc`);
  }
  if (ascFlags.some((f) => f !== undefined)) {
    throw new SigningError(
      "--local-asc-profile, --local-asc-bin and --local-notary-record need --local-notary asc",
    );
  }
  const [key, keyId, issuer] = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"].map((n) =>
    (env[n] ?? "").trim(),
  );
  if (!key || !keyId || !issuer) {
    throw new SigningError(
      "local signing needs APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER",
    );
  }
  return { ...base, notary: { kind: "p8", key, keyId, issuer } };
}
