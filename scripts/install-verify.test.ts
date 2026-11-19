// deploy/install.sh's verified-download routine against a release folder served from disk (file://), with a throwaway
// key pinned into a copy of the script. The routine is sourced (`source install.sh` defines functions and runs nothing)
// the way the root update helper reuses it. Needs OpenSSL 3 for Ed25519, like the script itself.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPrivateKey, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatChecksums, sha256, SIGNATURE_FILE, signChecksums } from "./release-kit.ts";
import { generateTestKey, type TestKey } from "./release-test-kit.ts";

const INSTALLER = join(import.meta.dir, "../deploy/install.sh");
const BINARY = "tomte-host-linux-x64";
const ASSETS = [BINARY, "tomte.service"];
const VERSION = "0.2.0";

const hasOpenssl3 =
  Bun.spawnSync(["bash", "-c", `source "${INSTALLER}"; openssl_has_ed25519`]).exitCode === 0;

let root: string;
let release: string;
let work: string;
let key: TestKey;
let script: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "install-verify-"));
  release = join(root, "release");
  work = join(root, "work");
  key = generateTestKey();
  await mkdir(release);
  await mkdir(work);
  script = await scriptPinning(key.publicKey);
});
afterEach(() => rm(root, { recursive: true, force: true }));

let copies = 0;
/** A copy of install.sh whose RELEASE_PUBLIC_KEY is `publicKey`, the way a person pins the real one. */
async function scriptPinning(publicKey: string): Promise<string> {
  const path = join(root, `install-${copies++}.sh`);
  const original = await readFile(INSTALLER, "utf8");
  expect(original.match(/^RELEASE_PUBLIC_KEY="[^"]*"$/gm)).toHaveLength(1);
  const text = original.replace(/^RELEASE_PUBLIC_KEY=".*"$/m, `RELEASE_PUBLIC_KEY="${publicKey}"`);
  await writeFile(path, text);
  return path;
}

/** A complete signed release folder. */
async function writeRelease(): Promise<void> {
  await writeFile(join(release, BINARY), "host binary bytes");
  await writeFile(join(release, "tomte.service"), "[Service]\n");
  await writeFile(
    join(release, "release.json"),
    `${JSON.stringify({ version: VERSION, shellApi: { min: 1, max: 1 }, schemaVersion: 7 }, null, 2)}\n`,
  );
  await rewriteSums();
}

async function rewriteSums(): Promise<void> {
  const names = [...ASSETS, "release.json"];
  const entries = await Promise.all(
    names.map(async (name) => ({ name, sha256: await sha256(join(release, name)) })),
  );
  await writeFile(join(release, "SHA256SUMS"), formatChecksums(entries));
  await signChecksums(release, key.privateKeyPem, key.publicKey);
}

async function download(scriptPath = script) {
  const result = Bun.spawnSync(
    [
      "bash",
      "-c",
      'source "$1"; download_verified_release "$2" "$3" "${@:4}"; printf "version=%s\\n" "$release_version"',
      "_",
      scriptPath,
      `file://${release}`,
      work,
      ...ASSETS,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe.skipIf(!hasOpenssl3)("download_verified_release", () => {
  test("a valid signed release downloads, verifies and reports its version", async () => {
    await writeRelease();
    const result = await download();
    expect(result.stderr).toBe("");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(`version=${VERSION}\n`);
    expect(await readFile(join(work, BINARY), "utf8")).toBe("host binary bytes");
  });

  test("a tampered binary is refused", async () => {
    await writeRelease();
    await writeFile(join(release, BINARY), "tampered");
    const result = await download();
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(`SHA-256 mismatch for ${BINARY}`);
  });

  test("a tampered SHA256SUMS fails the signature, even when it lists the tampered binary", async () => {
    await writeRelease();
    await writeFile(join(release, BINARY), "tampered");
    const forged = formatChecksums([
      { name: BINARY, sha256: await sha256(join(release, BINARY)) },
      { name: "tomte.service", sha256: await sha256(join(release, "tomte.service")) },
      { name: "release.json", sha256: await sha256(join(release, "release.json")) },
    ]);
    await writeFile(join(release, "SHA256SUMS"), forged);
    const result = await download();
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("does not verify against the pinned release key");
  });

  test("a signature by another key is refused", async () => {
    await writeRelease();
    const other = generateTestKey();
    await writeFile(
      join(release, SIGNATURE_FILE),
      sign(
        null,
        await readFile(join(release, "SHA256SUMS")),
        createPrivateKey(other.privateKeyPem),
      ),
    );
    const result = await download();
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("does not verify against the pinned release key");
  });

  test("a signature of the wrong length is refused", async () => {
    await writeRelease();
    await writeFile(join(release, SIGNATURE_FILE), "short");
    const result = await download();
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not 64 bytes");
  });

  test("a missing release.json is refused", async () => {
    await writeRelease();
    await rm(join(release, "release.json"));
    const result = await download();
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("release.json");
  });

  test("a release.json that SHA256SUMS does not cover, or that was changed, is refused", async () => {
    await writeRelease();
    await writeFile(join(release, "release.json"), '{"version":"9.9.9"}\n');
    const result = await download();
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("SHA-256 mismatch for release.json");
  });

  test("a binary SHA256SUMS does not list is refused", async () => {
    await writeRelease();
    await writeFile(join(release, "extra"), "x");
    const asked = Bun.spawnSync(
      [
        "bash",
        "-c",
        'source "$1"; download_verified_release "$2" "$3" extra',
        "_",
        script,
        `file://${release}`,
        work,
      ],
      { stderr: "pipe" },
    );
    expect(asked.exitCode).not.toBe(0);
    expect(asked.stderr.toString()).toContain("SHA256SUMS has no entry for extra");
  });

  test("a release signed under the pinned key does not verify under another pin", async () => {
    await writeRelease();
    const result = await download(await scriptPinning(generateTestKey().publicKey));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("does not verify against the pinned release key");
  });
});

describe("the pinned key placeholder", () => {
  test("the routine refuses while no key is pinned", async () => {
    await writeRelease();
    const result = await download(await scriptPinning(""));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("pins no release public key");
    expect(await Bun.file(join(work, BINARY)).exists()).toBe(false);
  });

  test("install.sh refuses a release install before touching the system, but not --url", async () => {
    const unpinned = await scriptPinning("");
    const fromRelease = Bun.spawnSync(["bash", unpinned, "--repo", "acme/tomte"], {
      stderr: "pipe",
    });
    expect(fromRelease.exitCode).toBe(1);
    expect(fromRelease.stderr.toString()).toContain("pins no release public key");

    const url = Bun.spawnSync(
      ["bash", unpinned, "--url", "https://example.invalid/x", "--sha256", "a".repeat(64)],
      { stderr: "pipe" },
    );
    expect(url.stderr.toString()).not.toContain("pins no release public key");
  });
});
