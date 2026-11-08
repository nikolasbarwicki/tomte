import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { isMusl } from "../harness/index.ts";
import { hostCommand } from "../platform/launch.ts";

const isWin = process.platform === "win32";
/** Where the managed engine is installed: `agent-browser/` in the data root. */
const managedRoot = (dataRoot: string) => join(dataRoot, "agent-browser");

export const ENGINE_VERSION = "0.41.2";

/** SHA-256 of each release binary, hashed locally from github.com/vercel-labs/agent-browser/releases/tag/v0.41.2. */
export const ENGINE_SHA256: Record<string, string> = {
  "darwin-arm64": "19680f06cf87d0095c318a2e80bea6b71523d95d3b651cd18d81885cd182477a",
  "darwin-x64": "fc55608c2222650e6e0d0154f9edebd203b63bf853b85d22240bfbddbb006ea1",
  "linux-arm64": "00d291f45e1c4d527b3aa08c70c54c7c3030fde0794f8d4575aaa3ca1680f728",
  "linux-musl-arm64": "730a5168153e27ad1243ebe960157e69de0f24531fbbac9a040856a491bf491f",
  "linux-musl-x64": "5d452d57772330fe4cef9b7aeb5e7137890dde20bbb65e82b990e0bc0b35d9cd",
  "linux-x64": "c4351f3802ffa5254d8c69f20a52e2fcf56925c6016fcf4203db25a07d811379",
  "win32-x64": "c2eadee7b67e326dfff02d5dd51a16ce7673eb165699d134b3ea5f05b4a7a9d0",
};

/** The engine's file name on this platform. */
export const ENGINE_BINARY = isWin ? "agent-browser.exe" : "agent-browser";

/**
 * The browser the desktop app ships: `browser-engine/` next to the host binary, holding the engine as `ENGINE_BINARY`
 * and Chrome for Testing unpacked under `chrome/`. Only a packaged host has one; from source it never exists.
 */
export const BUNDLE_DIR = "browser-engine";
const bundledRoot = () => join(dirname(process.execPath), BUNDLE_DIR);

export type ResolvedEngine = {
  path: string;
  source: "AGENT_BROWSER_PATH" | "bundled" | "managed" | "PATH";
};
export type EngineStatus =
  | { status: "available"; path: string; source: ResolvedEngine["source"] }
  /** `installable`: `installManagedEngine` can fix it on this platform. */
  | { status: "unavailable"; reason: string; installable?: boolean };

/** Release asset name suffix for this machine, or undefined when upstream ships no binary for it. */
export function platformKey(): string | undefined {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (!arch) return undefined;
  const os = process.platform === "linux" ? (isMusl() ? "linux-musl" : "linux") : process.platform;
  const key = `${os}-${arch}`;
  return key in ENGINE_SHA256 ? key : undefined;
}

function managedBinary(dataRoot: string): string | undefined {
  const marker = join(managedRoot(dataRoot), "current");
  if (!existsSync(marker)) return undefined;
  const p = readFileSync(marker, "utf8").trim();
  return existsSync(p) ? p : undefined;
}

function onPath(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(dir, ENGINE_BINARY);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

export function resolveEngine(
  dataRoot: string,
  bundle = bundledRoot(),
): ResolvedEngine | undefined {
  const pick = (path: string | undefined, source: ResolvedEngine["source"]) =>
    path && existsSync(path) ? { path, source } : undefined;
  return (
    pick(process.env.AGENT_BROWSER_PATH, "AGENT_BROWSER_PATH") ??
    pick(join(bundle, ENGINE_BINARY), "bundled") ??
    pick(managedBinary(dataRoot), "managed") ??
    pick(onPath(), "PATH")
  );
}

const CHROME_EXECUTABLE =
  process.platform === "darwin"
    ? ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]
    : process.platform === "win32"
      ? ["chrome.exe"]
      : ["chrome"];

/** Chrome in `dir` or in one of its folders (the zips unpack into a platform folder such as chrome-linux64). */
function chromeIn(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const bases = [
    dir,
    ...readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name)),
  ];
  return bases.map((b) => join(b, ...CHROME_EXECUTABLE)).find((p) => existsSync(p));
}

/** Chrome for Testing: `AGENT_BROWSER_EXECUTABLE_PATH`, else the bundled copy, else the newest one the engine installed. */
export function findChrome(bundle = bundledRoot()): string | undefined {
  const override = process.env.AGENT_BROWSER_EXECUTABLE_PATH;
  if (override && existsSync(override)) return override;
  const bundled = chromeIn(join(bundle, "chrome"));
  if (bundled) return bundled;
  const root = join(homedir(), ".agent-browser", "browsers");
  if (!existsSync(root)) return undefined;
  for (const version of readdirSync(root)
    .filter((d) => d.startsWith("chrome-"))
    .sort()
    .reverse()) {
    const found = chromeIn(join(root, version));
    if (found) return found;
  }
  return undefined;
}

export function engineStatus(dataRoot: string, bundle = bundledRoot()): EngineStatus {
  const e = resolveEngine(dataRoot, bundle);
  const hint = `run \`${hostCommand("install-browser", "--data-root", dataRoot)}\``;
  if (e) {
    if (!findChrome(bundle))
      return {
        status: "unavailable",
        reason: `Chrome for Testing is not installed; ${hint}`,
        installable: true,
      };
    return { status: "available", ...e };
  }
  return platformKey()
    ? { status: "unavailable", reason: `browser engine not installed; ${hint}`, installable: true }
    : {
        status: "unavailable",
        reason: `no agent-browser build for ${process.platform}/${process.arch}`,
      };
}

/** Runs the engine's own Chrome for Testing installer; its output goes to stderr, never stdout (a sidecar's stdout is the ready line). */
function installChrome(bin: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(bin, ["install"], { stdio: ["ignore", process.stderr, process.stderr] });
  child.on("error", (e) => reject(new Error(`chrome for testing install failed: ${e.message}`)));
  child.on("close", (code) =>
    code === 0 ? resolve() : reject(new Error("chrome for testing install failed")),
  );
  return promise;
}

/** Download the pinned engine, verify its pinned SHA-256, install Chrome for Testing through the engine, and mark it current. */
export async function installManagedEngine(
  dataRoot: string,
  version = ENGINE_VERSION,
): Promise<string> {
  if (version !== ENGINE_VERSION)
    throw new Error(
      `only the pinned agent-browser ${ENGINE_VERSION} can be installed (requested ${version})`,
    );
  const key = platformKey();
  if (!key) throw new Error(`no agent-browser build for ${process.platform}/${process.arch}`);
  const asset = `agent-browser-${key}${isWin ? ".exe" : ""}`;
  const res = await fetch(
    `https://github.com/vercel-labs/agent-browser/releases/download/v${version}/${asset}`,
  );
  if (!res.ok) throw new Error(`download failed: ${res.status} ${asset}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== ENGINE_SHA256[key])
    throw new Error(`checksum mismatch for ${asset}`);
  const dest = join(managedRoot(dataRoot), version);
  mkdirSync(dest, { recursive: true });
  const bin = join(dest, ENGINE_BINARY);
  const tmp = `${bin}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  if (!isWin) chmodSync(tmp, 0o755);
  renameSync(tmp, bin);
  try {
    await installChrome(bin);
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw e;
  }
  writeFileSync(join(managedRoot(dataRoot), "current"), bin);
  return bin;
}
