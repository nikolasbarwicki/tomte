import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHECKSUM_FILE,
  checkSignature,
  formatChecksums,
  MANIFEST_FILE,
  parsePinnedKey,
  parseTag,
  releaseForTag,
  SIGNATURE_FILE,
  signChecksums,
  writeChecksums,
  writeManifest,
} from "./release-kit.ts";
import { generateTestKey } from "./release-test-kit.ts";

describe("parseTag", () => {
  test("a plain version is a release, a suffix makes it a pre-release", () => {
    expect(parseTag("v1.2.0")).toEqual({ version: "1.2.0", prerelease: false });
    expect(parseTag("v1.2.0-rc.1")).toEqual({ version: "1.2.0-rc.1", prerelease: true });
    expect(parseTag("v0.1.0-beta")).toEqual({ version: "0.1.0-beta", prerelease: true });
  });

  test.each([
    "1.2.0",
    "v1.2",
    "v1.2.3.4",
    "v01.2.3",
    "v1.2.3-",
    "v1.2.3-rc.01",
    "v1.2.3+build",
    "vlatest",
    "v1.2.3 ",
  ])("refuses %p", (tag) => {
    expect(() => parseTag(tag)).toThrow("not a release tag");
  });
});

describe("releaseForTag", () => {
  test("passes when the tag's version is the host's", () => {
    expect(releaseForTag("v0.1.0", "0.1.0")).toEqual({ version: "0.1.0", prerelease: false });
  });

  test("refuses a tag that disagrees with the host, naming both versions", () => {
    expect(() => releaseForTag("v0.2.0", "0.1.0")).toThrow(
      /says 0\.2\.0 but the host reports 0\.1\.0/,
    );
  });

  test("a pre-release tag needs the suffix in the host version too", () => {
    expect(() => releaseForTag("v0.1.0-rc.1", "0.1.0")).toThrow("host reports 0.1.0");
    expect(releaseForTag("v0.1.0-rc.1", "0.1.0-rc.1").prerelease).toBe(true);
  });
});

describe("formatChecksums", () => {
  test("sha256sum format, sorted by name", () => {
    expect(
      formatChecksums([
        { name: "b", sha256: "bb" },
        { name: "a", sha256: "aa" },
      ]),
    ).toBe("aa  a\nbb  b\n");
  });
});

describe("writeChecksums", () => {
  let dir = "";
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const setup = async (files: Record<string, string>) => {
    dir = await mkdtemp(join(tmpdir(), "release-kit-"));
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  };

  test("covers every file, in a form `sha256sum --check` accepts, and is not itself covered", async () => {
    await setup({ "a.bin": "hello", "b.exe": "" });
    const first = await writeChecksums(dir, ["a.bin"]);
    expect(first).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  a.bin\n" +
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  b.exe\n",
    );
    expect(await readFile(join(dir, CHECKSUM_FILE), "utf8")).toBe(first);
    expect(await writeChecksums(dir, [])).toBe(first);
  });

  test("fails when a required file is missing or a folder is in the way", async () => {
    await setup({ "a.bin": "x" });
    await expect(writeChecksums(dir, ["a.bin", "b.bin"])).rejects.toThrow("missing from");
    await mkdir(join(dir, "nested"));
    await expect(writeChecksums(dir, [])).rejects.toThrow("is not a file");
  });
});

describe("the release signature", () => {
  const key = generateTestKey();
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "release-sign-"));
    await writeFile(join(dir, "a.bin"), "hello");
    await writeChecksums(dir, ["a.bin"]);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("signs SHA256SUMS with a raw 64-byte signature that the pinned key verifies, and a rerun's sums never list it", async () => {
    await signChecksums(dir, key.privateKeyPem, key.publicKey);
    const signature = await readFile(join(dir, SIGNATURE_FILE));
    const sums = await readFile(join(dir, CHECKSUM_FILE));
    expect(signature.length).toBe(64);
    expect(checkSignature(sums, signature, key.publicKey)).toBe(true);
    expect(await writeChecksums(dir, ["a.bin"])).not.toContain(SIGNATURE_FILE);
  });

  test("a tampered SHA256SUMS or a signature by another key does not verify", async () => {
    await signChecksums(dir, key.privateKeyPem, key.publicKey);
    const signature = await readFile(join(dir, SIGNATURE_FILE));
    const sums = await readFile(join(dir, CHECKSUM_FILE));
    const tampered = Buffer.concat([sums, Buffer.from("x")]);
    expect(checkSignature(tampered, signature, key.publicKey)).toBe(false);
    expect(checkSignature(sums, signature, generateTestKey().publicKey)).toBe(false);
    expect(checkSignature(sums, signature.subarray(1), key.publicKey)).toBe(false);
  });

  test("refuses to sign without a key, with a key that is not the pinned one's pair, or with a non-Ed25519 key", async () => {
    await expect(signChecksums(dir, "  \n", key.publicKey)).rejects.toThrow("is not set");
    await expect(
      signChecksums(dir, key.privateKeyPem, generateTestKey().publicKey),
    ).rejects.toThrow("does not belong to the public key pinned");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    await expect(signChecksums(dir, rsa, key.publicKey)).rejects.toThrow("not Ed25519");
    expect(await Bun.file(join(dir, SIGNATURE_FILE)).exists()).toBe(false);
  });
});

describe("parsePinnedKey", () => {
  const key = generateTestKey().publicKey;

  test("reads the pinned key", () => {
    expect(parsePinnedKey(`set -e\nRELEASE_PUBLIC_KEY="${key}"\n`)).toBe(key);
  });

  test("an empty pin is the placeholder and refuses", () => {
    expect(() => parsePinnedKey('RELEASE_PUBLIC_KEY=""\n')).toThrow(
      "no release public key is pinned",
    );
  });

  test("a missing line or a malformed key refuses", () => {
    expect(() => parsePinnedKey("set -e\n")).toThrow("no RELEASE_PUBLIC_KEY line");
    expect(() => parsePinnedKey('RELEASE_PUBLIC_KEY="not a key"\n')).toThrow("not the base64");
  });
});

describe("writeManifest", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "release-manifest-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("writes release.json with one key per line, version first", async () => {
    await writeManifest(dir, { version: "0.2.0", shellApi: { min: 1, max: 2 }, schemaVersion: 31 });
    const text = await readFile(join(dir, MANIFEST_FILE), "utf8");
    expect(text.split("\n")[1]).toBe('  "version": "0.2.0",');
    expect(JSON.parse(text)).toEqual({
      version: "0.2.0",
      shellApi: { min: 1, max: 2 },
      schemaVersion: 31,
    });
  });

  test("refuses an empty shell API range or a schema version that is not a count", async () => {
    await expect(
      writeManifest(dir, { version: "0.2.0", shellApi: { min: 3, max: 2 }, schemaVersion: 1 }),
    ).rejects.toThrow("is empty");
    await expect(
      writeManifest(dir, { version: "0.2.0", shellApi: { min: 1, max: 1 }, schemaVersion: 0 }),
    ).rejects.toThrow();
  });
});
