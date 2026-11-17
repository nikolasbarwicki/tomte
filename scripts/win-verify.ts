// What a signed Windows release must pass, as one PowerShell run through a {@link Runner}: the installer, the app, the
// bundled host, the browser's engine and every `.exe` and `.dll` of the bundled Chrome. `signing.ts verify` (CI) calls it.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { BUNDLE_DIR } from "../packages/host/src/browser/engine.ts";
import { type BundleFiles, diskFiles } from "./bundle-files.ts";
import type { Runner } from "./command-runner.ts";
import { bundledAppPath, bundledHostPath, desktopAssets } from "./desktop-kit.ts";
import { checkSignedWindows, parseAuthenticodeLines, SigningError } from "./signing-kit.ts";

// Set-AuthenticodeSignature's reader ships with every Windows image. The files come in a list file, one path per line
// (the Chrome folder holds dozens, more than a safe command line), and the output is `path|status|thumbprint|timestamped`.
const AUTHENTICODE_SCRIPT = `
$ErrorActionPreference = 'Stop'
foreach ($p in Get-Content -LiteralPath $args[0] -Encoding UTF8) {
  if ($p -eq '') { continue }
  $s = Get-AuthenticodeSignature -LiteralPath $p
  $t = if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { '' }
  '{0}|{1}|{2}|{3}' -f $p, $s.Status, $t, ($null -ne $s.TimeStamperCertificate)
}
`;

/** Every `.exe` and `.dll` under `dir`, however deep, in a stable order. */
async function binariesUnder(files: BundleFiles, dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const e of await files.list(dir)) {
    const path = join(dir, e.name);
    if (e.kind === "dir") found.push(...(await binariesUnder(files, path)));
    else if (/\.(exe|dll)$/i.test(e.name)) found.push(path);
  }
  return found.sort();
}

/**
 * What must be signed, in the order it is checked: the installer, the app, the host, the engine, and every `.exe` and
 * `.dll` under `browser-engine\chrome` (listed from the bundle, so a library a new Chrome adds is covered). Throws when
 * the browser is not there: a signed release without it is broken.
 */
async function signedFiles(
  files: BundleFiles,
  bundleDir: string,
  version: string,
): Promise<string[]> {
  const browser = join(bundleDir, dirname(bundledHostPath("win32", "x64")), BUNDLE_DIR);
  const engine = join(browser, "agent-browser.exe");
  const chromeDir = join(browser, "chrome");
  const chrome = (await files.exists(chromeDir)) ? await binariesUnder(files, chromeDir) : [];
  const missing: string[] = [];
  if (!(await files.exists(engine))) missing.push(engine);
  if (!chrome.some((f) => /[\\/]chrome\.exe$/i.test(f))) {
    missing.push(join(chromeDir, "<chrome-win64>", "chrome.exe"));
  }
  if (!chrome.some((f) => /\.dll$/i.test(f))) missing.push(join(chromeDir, "**", "*.dll"));
  if (missing.length > 0) {
    throw new SigningError(
      `the bundled browser is incomplete, missing:\n- ${missing.join("\n- ")}`,
    );
  }
  return [
    join(bundleDir, desktopAssets("win32", ["x64"], version).installers[0] as string),
    join(bundleDir, bundledAppPath("win32", "x64")),
    join(bundleDir, bundledHostPath("win32", "x64")),
    engine,
    ...chrome,
  ];
}

/** The installer, the app, the host and the whole browser: valid, timestamped, one certificate. */
export async function verifyWindowsBundle(
  run: Runner,
  bundleDir: string,
  version: string,
  log: (line: string) => void = console.log,
  files: BundleFiles = diskFiles,
): Promise<void> {
  const paths = await signedFiles(files, bundleDir, version);
  const tmp = await mkdtemp(join(tmpdir(), "tomte-verify-"));
  try {
    const script = join(tmp, "verify.ps1");
    const list = join(tmp, "files.txt");
    await writeFile(script, AUTHENTICODE_SCRIPT);
    await writeFile(list, paths.join("\n"));
    const out = await run(["powershell", "-NoProfile", "-NonInteractive", "-File", script, list]);
    const records = parseAuthenticodeLines(out.stdout);
    const problems = checkSignedWindows(records);
    if (records.length !== paths.length)
      problems.push(`expected ${paths.length} files, checked ${records.length}`);
    if (problems.length > 0) throw new SigningError(`- ${problems.join("\n- ")}`);
    for (const r of records) log(`ok ${r.path} (${r.thumbprint})`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
