import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DesktopScope,
  desktopAssets,
  desktopScope,
  SUPPORTED_DESKTOP,
} from "./desktop-kit.ts";
import { signChecksums, writeChecksums, writeManifest } from "./release-kit.ts";
import { generateTestKey } from "./release-test-kit.ts";
import {
  checksumRequirements,
  expectedFiles,
  parseChecksums,
  parseUpdateMetadata,
  verifyRelease as verifyReleaseWith,
} from "./release-verify.ts";

const VERSION = "0.2.0-rc.1";
const key = generateTestKey();
/** Written by writeRelease itself, not as filler bytes. */
const SKIPPED = ["SHA256SUMS", "SHA256SUMS.sig", "release.json", "install.sh"];
const verifyRelease = (folder: string, version: string) =>
  verifyReleaseWith(folder, version, key.publicKey);
const installer = (repo: string, publicKey: string) =>
  `set -e\nDEFAULT_REPO="${repo}"\nRELEASE_PUBLIC_KEY="${publicKey}"\n`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "release-verify-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const yml = (version: string, files: { url: string; bytes: string }[]) =>
  [
    `version: ${version}`,
    "files:",
    ...files.flatMap((f) => [
      `  - url: ${f.url}`,
      `    sha512: ${createHash("sha512").update(f.bytes).digest("base64")}`,
      `    size: ${f.bytes.length}`,
    ]),
    `path: ${files[0]?.url}`,
    `sha512: ${createHash("sha512")
      .update(files[0]?.bytes ?? "")
      .digest("base64")}`,
    "releaseDate: '2026-11-08T00:00:00.000Z'",
    "",
  ].join("\n");

/** A complete, consistent release folder of small fixture files, holding the scope's installers. */
async function writeRelease(
  version = VERSION,
  scope: DesktopScope = SUPPORTED_DESKTOP,
): Promise<void> {
  const { required } = expectedFiles(version, scope);
  const metadata = new Set(
    (["darwin", "win32", "linux"] as const).map((p) => desktopAssets(p, ["x64"], version).metadata),
  );
  for (const name of required) {
    if (SKIPPED.includes(name) || metadata.has(name)) continue;
    await writeFile(join(dir, name), `bytes of ${name}`);
  }
  await writeFile(join(dir, "install.sh"), installer("acme/tomte-fixture", key.publicKey));
  await writeManifest(dir, { version, shellApi: { min: 1, max: 1 }, schemaVersion: 7 });
  for (const platform of ["darwin", "win32", "linux"] as const) {
    if (scope[platform].length === 0) continue;
    const { installers, metadata: name } = desktopAssets(platform, scope[platform], version);
    const listed = installers.filter(
      (n) =>
        n.endsWith(".zip") || n.endsWith(".dmg") || n.endsWith(".exe") || n.endsWith(".AppImage"),
    );
    await writeFile(
      join(dir, name),
      yml(
        version,
        listed.map((url) => ({ url, bytes: `bytes of ${url}` })),
      ),
    );
  }
  await writeChecksums(
    dir,
    required.filter((n) => n !== "SHA256SUMS" && n !== "SHA256SUMS.sig"),
  );
  await signChecksums(dir, key.privateKeyPem, key.publicKey);
}

describe("verifyRelease", () => {
  test("a complete consistent folder has no problems", async () => {
    await writeRelease();
    expect(await verifyRelease(dir, VERSION)).toEqual([]);
  });

  test("a tampered asset is a checksum mismatch", async () => {
    await writeRelease();
    await writeFile(join(dir, "tomte-host-linux-x64"), "tampered");
    expect(await verifyRelease(dir, VERSION)).toEqual([
      "sha256 mismatch: tomte-host-linux-x64 does not match SHA256SUMS",
    ]);
  });

  test("a missing asset is named, and SHA256SUMS still lists it", async () => {
    await writeRelease();
    await rm(join(dir, `Tomte-${VERSION}.deb`));
    const problems = await verifyRelease(dir, VERSION);
    expect(problems).toContain(`missing: Tomte-${VERSION}.deb`);
    expect(problems).toContain(`SHA256SUMS lists Tomte-${VERSION}.deb, which is not in the folder`);
  });

  test("a missing blockmap fails but the deb has none to miss", async () => {
    await writeRelease();
    await rm(join(dir, `Tomte-Setup-${VERSION}.exe.blockmap`));
    expect(await verifyRelease(dir, VERSION)).toContain(
      `missing: Tomte-Setup-${VERSION}.exe.blockmap`,
    );
  });

  test("a DMG's blockmap may be there (CI) or not (a stapled local DMG)", async () => {
    await writeRelease();
    expect(await verifyRelease(dir, VERSION)).toEqual([]);
    for (const dmg of [`Tomte-${VERSION}-arm64.dmg`, `Tomte-${VERSION}.dmg`]) {
      await writeFile(join(dir, `${dmg}.blockmap`), `blockmap of ${dmg}`);
    }
    await writeChecksums(dir, []);
    await signChecksums(dir, key.privateKeyPem, key.publicKey);
    expect(await verifyRelease(dir, VERSION)).toEqual([]);
  });

  test("another version's folder reports every asset as missing and unexpected", async () => {
    await writeRelease("0.1.0");
    const problems = await verifyRelease(dir, VERSION);
    expect(problems).toContain(`missing: Tomte-Setup-${VERSION}.exe`);
    expect(problems).toContain("unexpected: Tomte-Setup-0.1.0.exe");
  });

  test("a file the checksums do not cover is named", async () => {
    await writeRelease();
    await writeFile(join(dir, "notes.txt"), "extra");
    const problems = await verifyRelease(dir, VERSION);
    expect(problems).toContain("unexpected: notes.txt");
    expect(problems).toContain("SHA256SUMS has no entry for notes.txt");
  });

  test("an empty DEFAULT_REPO means the workflow never filled it in", async () => {
    await writeRelease();
    await writeFile(join(dir, "install.sh"), installer("", key.publicKey));
    const problems = await verifyRelease(dir, VERSION);
    expect(problems).toContain('install.sh has DEFAULT_REPO="", expected OWNER/REPO');
  });

  test("an update metadata file for another version, or with a wrong hash or size, fails", async () => {
    await writeRelease();
    const mac = join(dir, "latest-mac.yml");
    const text = await readFile(mac, "utf8");
    await writeFile(mac, text.replace(`version: ${VERSION}`, "version: 0.1.0"));
    expect(await verifyRelease(dir, VERSION)).toContain(
      `latest-mac.yml names version 0.1.0, the release is ${VERSION}`,
    );

    await writeFile(
      mac,
      text.replace(/sha512: \S+/, "sha512: AAAA").replace(/size: \d+/, "size: 1"),
    );
    const problems = await verifyRelease(dir, VERSION);
    expect(problems.some((p) => p.startsWith("SHA256SUMS"))).toBe(false);
    expect(problems.some((p) => p.includes("sha512 of") && p.includes("does not match"))).toBe(
      true,
    );
    expect(problems.some((p) => p.includes("the metadata says 1"))).toBe(true);
  });

  test("update metadata must list the installer the updater applies", async () => {
    await writeRelease();
    await writeFile(join(dir, "latest.yml"), `version: ${VERSION}\nfiles:\n`);
    const problems = await verifyRelease(dir, VERSION);
    expect(problems).toContain("latest.yml lists no files");
    expect(problems).toContain(`latest.yml does not list Tomte-Setup-${VERSION}.exe`);
  });

  test("a malformed SHA256SUMS is reported, not skipped", async () => {
    await writeRelease();
    await writeFile(join(dir, "SHA256SUMS"), "not a checksum line\n");
    const problems = await verifyRelease(dir, VERSION);
    expect(problems[0]).toContain("line 1 is not");
    expect(problems).toContain("SHA256SUMS has no entry for install.sh");
  });

  test("a missing release.json, a manifest for another version and an empty shell API range each fail", async () => {
    await writeRelease();
    const manifest = join(dir, "release.json");
    const text = await readFile(manifest, "utf8");
    await rm(manifest);
    expect(await verifyRelease(dir, VERSION)).toContain("missing: release.json");

    await writeFile(manifest, text.replace(VERSION, "0.1.0"));
    expect(await verifyRelease(dir, VERSION)).toContain(
      `release.json names version 0.1.0, the release is ${VERSION}`,
    );

    await writeFile(manifest, '{"version":"x"}');
    expect(
      (await verifyRelease(dir, VERSION)).some((p) => p.includes("not a release manifest")),
    ).toBe(true);

    await writeFile(
      manifest,
      JSON.stringify({ version: VERSION, shellApi: { min: 3, max: 2 }, schemaVersion: 7 }),
    );
    expect(await verifyRelease(dir, VERSION)).toContain("release.json has an empty shellApi range");
  });

  test("a missing signature, a tampered SHA256SUMS and a signature by another key each fail", async () => {
    await writeRelease();
    const signature = join(dir, "SHA256SUMS.sig");
    const good = await readFile(signature);
    await rm(signature);
    expect(await verifyRelease(dir, VERSION)).toContain("missing: SHA256SUMS.sig");

    await writeFile(signature, good);
    await writeFile(
      join(dir, "SHA256SUMS"),
      `${await readFile(join(dir, "SHA256SUMS"), "utf8")}\n`,
    );
    expect(await verifyRelease(dir, VERSION)).toContain(
      "SHA256SUMS.sig is not a valid signature of SHA256SUMS by the pinned release key",
    );

    await writeRelease();
    expect(await verifyRelease(dir, VERSION)).toEqual([]);
    expect(await verifyReleaseWith(dir, VERSION, generateTestKey().publicKey)).toContain(
      "SHA256SUMS.sig is not a valid signature of SHA256SUMS by the pinned release key",
    );
  });

  test("an installer that pins another key, or none, is reported", async () => {
    await writeRelease();
    await writeFile(join(dir, "install.sh"), installer("acme/tomte-fixture", ""));
    expect(await verifyRelease(dir, VERSION)).toContain(
      "install.sh does not pin the release public key of this checkout",
    );
  });
});

describe("a release folder scoped to some installers (--only)", () => {
  const armOnly = desktopScope(["darwin-arm64"]);

  test("an arm64-only folder passes its scope and still fails a full check", async () => {
    await writeRelease(VERSION, armOnly);
    expect(await verifyReleaseWith(dir, VERSION, key.publicKey, armOnly)).toEqual([]);
    const full = await verifyRelease(dir, VERSION);
    expect(full).toContain(`missing: Tomte-${VERSION}.dmg`);
    expect(full).toContain(`missing: Tomte-Setup-${VERSION}.exe`);
    expect(full).toContain("missing: latest-linux.yml");
  });

  test("every host binary is still required, and other installers are unexpected", async () => {
    await writeRelease(VERSION, armOnly);
    await rm(join(dir, "tomte-host-windows-x64.exe"));
    await writeFile(join(dir, `Tomte-Setup-${VERSION}.exe`), "stray");
    const problems = await verifyReleaseWith(dir, VERSION, key.publicKey, armOnly);
    expect(problems).toContain("missing: tomte-host-windows-x64.exe");
    expect(problems).toContain(`unexpected: Tomte-Setup-${VERSION}.exe`);
  });

  test("checksums require the scope's installers and the host binaries", () => {
    const required = checksumRequirements(VERSION, armOnly);
    expect(required).toContain(`Tomte-${VERSION}-arm64-mac.zip`);
    expect(required).toContain("tomte-host-linux-arm64");
    expect(required).not.toContain(`Tomte-${VERSION}-mac.zip`);
    expect(required).not.toContain("latest.yml");
  });

  test("checksums refuse a folder without a license file, scoped or not", async () => {
    await writeRelease(VERSION, armOnly);
    await rm(join(dir, "NOTICE"));
    await expect(writeChecksums(dir, checksumRequirements(VERSION, armOnly))).rejects.toThrow(
      /missing from .*: NOTICE$/,
    );
    expect(checksumRequirements(VERSION)).toEqual(
      expect.arrayContaining(["LICENSE", "NOTICE", "THIRD-PARTY-LICENSES.txt", "release.json"]),
    );
  });
});

describe("parseUpdateMetadata", () => {
  test("reads electron-builder's block YAML, quoted values included", () => {
    const meta = parseUpdateMetadata(
      [
        "version: 1.0.0",
        "files:",
        "  - url: a.zip",
        "    sha512: AbC+/==",
        "    size: 12",
        "  - url: 'b b.dmg'",
        "    sha512: Zm9v",
        "    size: 3",
        "    blockMapSize: 99",
        "path: a.zip",
        "sha512: AbC+/==",
        "",
      ].join("\n"),
    );
    expect(meta).toEqual({
      version: "1.0.0",
      path: "a.zip",
      sha512: "AbC+/==",
      files: [
        { url: "a.zip", sha512: "AbC+/==", size: 12 },
        { url: "b b.dmg", sha512: "Zm9v", size: 3 },
      ],
    });
  });

  test("drops an entry without a size", () => {
    expect(parseUpdateMetadata("files:\n  - url: a\n    sha512: x\n").files).toEqual([]);
  });
});

describe("parseChecksums", () => {
  const hash = "a".repeat(64);

  test("sha256sum lines; duplicates and subfolder names are problems", () => {
    const { entries, problems } = parseChecksums(
      `${hash}  a\n${hash}  a\n${hash}  dir/b\n${"b".repeat(64)}  c\n`,
    );
    expect([...entries.keys()]).toEqual(["a", "c"]);
    expect(problems).toEqual([
      "SHA256SUMS lists a more than once",
      expect.stringContaining("line 3"),
    ]);
  });
});
