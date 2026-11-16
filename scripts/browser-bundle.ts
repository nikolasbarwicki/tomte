import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The browser the desktop app ships, so its agents can browse on first launch with nothing to download:
// the pinned agent-browser engine and the pinned Chrome for Testing, both checked against SHA-256s in this repo,
// laid out as BUNDLE_DIR (engine as ENGINE_BINARY, Chrome unpacked under chrome/) for engine.ts to find next to the host.
// Full Chrome for Testing, not chrome-headless-shell: bots can run headed in local mode, which the headless shell cannot.
// Downloads are cached in dist/browser-cache/ (gitignored) and re-verified on every use.
import {
  BUNDLE_DIR,
  ENGINE_BINARY,
  ENGINE_SHA256,
  ENGINE_VERSION,
} from "../packages/host/src/browser/engine.ts";

const CACHE = join(import.meta.dir, "..", "dist/browser-cache");

const CHROME_VERSION = "157.0.8103.38";

/** SHA-256 of each Chrome for Testing zip, hashed locally from storage.googleapis.com/chrome-for-testing-public/157.0.8103.38. */
const CHROME_SHA256: Record<string, { platform: string; sha256: string }> = {
  "darwin-arm64": {
    platform: "mac-arm64",
    sha256: "3406b38b52b7d341d74450eb7b369be038c9fec9894c8b8a9e9e9f97333caf2f",
  },
  "darwin-x64": {
    platform: "mac-x64",
    sha256: "c6fcc2869b0d5a421e880d7bcdabe96e4261c4100e125fc4e4daf6346474efa6",
  },
  "linux-arm64": {
    platform: "linux-arm64",
    sha256: "5517510e61657ff43ee9ab804ecd1a499b3d5bd3caf72f097516bd6565ba5a17",
  },
  "linux-x64": {
    platform: "linux64",
    sha256: "8cdeb344e9b2cefe59f4aea8d1d93d5d93054c03cde217665c16fc1f62e72a66",
  },
  "win32-x64": {
    platform: "win64",
    sha256: "ae0deef27d449e1d7529df7705d609bab102de48464da13567ed3dd2ee1a0586",
  },
};

/** The file at `url`, from the cache when its bytes still match `sha256`, else downloaded, checked and cached. */
async function fetchVerified(url: string, name: string, sha256: string): Promise<string> {
  const file = join(CACHE, name);
  const matches = async () =>
    (await Bun.file(file).exists()) &&
    createHash("sha256")
      .update(new Uint8Array(await Bun.file(file).arrayBuffer()))
      .digest("hex") === sha256;
  if (await matches()) return file;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  await mkdir(CACHE, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, new Uint8Array(await res.arrayBuffer()));
  await rename(tmp, file);
  if (!(await matches())) {
    await rm(file, { force: true });
    throw new Error(`checksum mismatch for ${name}`);
  }
  return file;
}

/** Unzips with the OS tool that keeps the app bundle intact: `ditto` keeps macOS symlinks and attributes. */
async function unzip(zip: string, dest: string): Promise<void> {
  const cmd =
    process.platform === "darwin"
      ? ["ditto", "-x", "-k", zip, dest]
      : process.platform === "win32"
        ? ["tar", "-xf", zip, "-C", dest]
        : ["unzip", "-q", zip, "-d", dest];
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`unpacking ${zip} failed`);
}

/** Lays out BUNDLE_DIR for `arch` (default this machine's) on this OS in `stageDir` and returns its path. Throws when that platform has no pinned engine or Chrome. */
export async function prepareBrowserBundle(
  stageDir: string,
  arch: string = process.arch,
): Promise<string> {
  const key = `${process.platform}-${arch}`;
  const chrome = CHROME_SHA256[key];
  if (!chrome || !(key in ENGINE_SHA256))
    throw new Error(`no pinned agent-browser and Chrome for ${process.platform}/${arch}`);
  const asset = `agent-browser-${key}${process.platform === "win32" ? ".exe" : ""}`;
  const engine = await fetchVerified(
    `https://github.com/vercel-labs/agent-browser/releases/download/v${ENGINE_VERSION}/${asset}`,
    `${ENGINE_VERSION}-${asset}`,
    ENGINE_SHA256[key]!,
  );
  const zip = await fetchVerified(
    `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${chrome.platform}/chrome-${chrome.platform}.zip`,
    `${CHROME_VERSION}-chrome-${chrome.platform}.zip`,
    chrome.sha256,
  );
  const bundle = join(stageDir, BUNDLE_DIR);
  await rm(bundle, { recursive: true, force: true });
  await mkdir(join(bundle, "chrome"), { recursive: true });
  const bin = join(bundle, ENGINE_BINARY);
  await Bun.write(bin, Bun.file(engine));
  await chmod(bin, 0o755);
  await unzip(zip, join(bundle, "chrome"));
  return bundle;
}
