// The release workflow's signing steps, as commands (`.github/workflows/release.yml`, AGENTS.md "Releasing"):
//   bun scripts/signing.ts plan
//       reads the signing secrets from the environment (only their presence), prints which platforms are signed, appends
//       `mac=` and `windows=` (true/false) to $GITHUB_OUTPUT and a summary to $GITHUB_STEP_SUMMARY; exits non-zero when
//       a platform is partly configured, or when CLAUDEBOT_REQUIRE_SIGNING=true and one has no secrets.
//   bun scripts/signing.ts sign-host <binary>
//       signs the host binary in place with this OS's identity (macOS: Developer ID Application, hardened runtime,
//       timestamp and the entitlements of scripts/entitlements.mac.plist; Windows: Authenticode, SHA-256, timestamped).
//   bun scripts/signing.ts verify <bundleDir> <version> <arch>...
//       checks a signed `package:desktop` run for this OS: the apps, the macOS update zips and the installer are signed
//       and valid, notarized and stapled (macOS), and the bundled host is signed by the same identity as the app.
// `sign-host` changes the keychain and the certificate store, so it refuses to run outside GitHub Actions. A developer
// machine never signs through this script; `package:desktop --sign` has its own credential rules (package-desktop.ts).
// The secrets are never put on a command line this script prints, and its temporary keychain and files are removed.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { spawnRunner } from "./command-runner.ts";
import { bundledAppPath, bundledHostPath, desktopAssets, isDesktopArch } from "./desktop-kit.ts";
import { verifyMacBundle } from "./mac-verify.ts";
import {
  checkSignedWindows,
  MAC_ENTITLEMENTS,
  parseAuthenticodeLines,
  parseDeveloperIdIdentity,
  planSigning,
  type SigningDecision,
  SigningError,
  type SigningPlatform,
  signingRequired,
  signingSummary,
  TIMESTAMP_URL,
} from "./signing-kit.ts";

const USAGE =
  "usage: bun scripts/signing.ts plan | sign-host <binary> | verify <bundleDir> <version> <arch>...";

const run = spawnRunner;

function plan(): number {
  const required = signingRequired(process.env);
  const decisions: SigningDecision[] = [];
  const errors: string[] = [];
  for (const platform of ["darwin", "win32"] as const) {
    try {
      decisions.push(planSigning(platform, process.env, required));
    } catch (error) {
      if (!(error instanceof SigningError)) throw error;
      errors.push(error.message);
    }
  }
  if (errors.length > 0) {
    const text = `### Signing: the release fails\n\n${errors.map((e) => `- ${e}`).join("\n")}\n`;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
    console.error(errors.join("\n"));
    return 1;
  }
  const signed = (platform: SigningPlatform) =>
    decisions.some((d) => d.signed && d.platform === platform);
  const outputs = `mac=${signed("darwin")}\nwindows=${signed("win32")}\n`;
  const summary = signingSummary(decisions, required);
  process.stdout.write(`${outputs}${summary}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  return 0;
}

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
};

/** Signs `binary` with the Developer ID Application identity in the base64 .p12, in a keychain that exists only for this call. */
async function signHostMac(binary: string, dir: string): Promise<void> {
  const keychain = join(dir, "signing.keychain-db");
  const keychainPassword = randomBytes(24).toString("hex");
  const p12 = join(dir, "certificate.p12");
  await writeFile(p12, Buffer.from(required("MACOS_CERTIFICATE_P12"), "base64"), { mode: 0o600 });
  const before = (await run(["security", "list-keychains", "-d", "user"])).stdout
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter((line) => line !== "");
  try {
    await run(["security", "create-keychain", "-p", keychainPassword, keychain]);
    await run(["security", "set-keychain-settings", "-lut", "3600", keychain]);
    await run(["security", "unlock-keychain", "-p", keychainPassword, keychain]);
    await run([
      "security",
      "import",
      p12,
      "-k",
      keychain,
      "-P",
      required("MACOS_CERTIFICATE_PASSWORD"),
      "-f",
      "pkcs12",
      "-T",
      "/usr/bin/codesign",
    ]);
    await run([
      "security",
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      keychainPassword,
      keychain,
    ]);
    await run(["security", "list-keychains", "-d", "user", "-s", keychain, ...before]);
    const identity = parseDeveloperIdIdentity(
      (await run(["security", "find-identity", "-v", "-p", "codesigning", keychain])).stdout,
    );
    await run([
      "codesign",
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      MAC_ENTITLEMENTS,
      "--keychain",
      keychain,
      "--sign",
      identity.hash,
      binary,
    ]);
    await run(["codesign", "--verify", "--strict", "--verbose=2", binary]);
    console.log(`signed ${binary} as ${identity.name}`);
  } finally {
    await run(["security", "list-keychains", "-d", "user", "-s", ...before]).catch(() => {});
    await run(["security", "delete-keychain", keychain]).catch(() => {});
  }
}

// Set-AuthenticodeSignature ships with every Windows image, so no Windows SDK path has to be found for signtool. The
// certificate password and the paths come in through the environment, never through this script's text.
const SIGN_WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($env:SIGN_PFX_PATH, $env:WINDOWS_CERTIFICATE_PASSWORD)
$result = Set-AuthenticodeSignature -LiteralPath $env:SIGN_TARGET -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $env:SIGN_TIMESTAMP_URL
if ($result.Status -ne 'Valid') { throw "$($env:SIGN_TARGET): status $($result.Status): $($result.StatusMessage)" }
`;

async function signHostWindows(binary: string, dir: string): Promise<void> {
  const pfx = join(dir, "certificate.pfx");
  await writeFile(pfx, Buffer.from(required("WINDOWS_CERTIFICATE_PFX"), "base64"), { mode: 0o600 });
  const script = join(dir, "sign.ps1");
  await writeFile(script, SIGN_WINDOWS_SCRIPT);
  await run(["powershell", "-NoProfile", "-NonInteractive", "-File", script], {
    SIGN_PFX_PATH: pfx,
    SIGN_TARGET: binary,
    SIGN_TIMESTAMP_URL: TIMESTAMP_URL,
  });
  console.log(`signed ${binary}`);
}

async function signHost(binary: string): Promise<void> {
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error(
      "sign-host changes the keychain or certificate store: it runs only in GitHub Actions",
    );
  }
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(`there is no host signing on ${platform}`);
  }
  planSigning(platform, process.env, true);
  const dir = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "claudebot-sign-"));
  try {
    const target = resolve(binary);
    await (platform === "darwin" ? signHostMac(target, dir) : signHostWindows(target, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const AUTHENTICODE_SCRIPT = `
$ErrorActionPreference = 'Stop'
foreach ($p in $args) {
  $s = Get-AuthenticodeSignature -LiteralPath $p
  $t = if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { '' }
  '{0}|{1}|{2}|{3}' -f $p, $s.Status, $t, ($null -ne $s.TimeStamperCertificate)
}
`;

/** The installer, the app and the bundled host: valid, timestamped, one certificate. */
async function verifyWindows(bundleDir: string, version: string): Promise<void> {
  const files = [
    join(bundleDir, desktopAssets("win32", ["x64"], version).installers[0] as string),
    join(bundleDir, bundledAppPath("win32", "x64")),
    join(bundleDir, bundledHostPath("win32", "x64")),
  ];
  const tmp = await mkdtemp(join(tmpdir(), "claudebot-verify-"));
  try {
    const script = join(tmp, "verify.ps1");
    await writeFile(script, AUTHENTICODE_SCRIPT);
    const out = await run([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      script,
      ...files,
    ]);
    const records = parseAuthenticodeLines(out.stdout);
    const problems = checkSignedWindows(records);
    if (records.length !== files.length)
      problems.push(`expected ${files.length} files, checked ${records.length}`);
    if (problems.length > 0) throw new SigningError(`- ${problems.join("\n- ")}`);
    for (const r of records) console.log(`ok ${r.path} (${r.thumbprint})`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan" && args.length === 0) return plan();
  if (command === "sign-host" && args.length === 1) {
    await signHost(args[0] as string);
    return 0;
  }
  if (command === "verify" && args.length >= 3) {
    const [bundleDir, version, ...archs] = args as [string, string, ...string[]];
    if (!archs.every(isDesktopArch)) {
      console.error("arch is arm64 or x64");
      return 2;
    }
    if (process.platform === "darwin") await verifyMacBundle(run, bundleDir, version, archs);
    else if (process.platform === "win32") await verifyWindows(bundleDir, version);
    else throw new Error(`there is nothing to verify on ${process.platform}`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

process.exitCode = await main().catch((e: Error) => {
  console.error(e.message);
  return 1;
});
