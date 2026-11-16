import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { desktopAssets } from "./desktop-kit.ts";
import { writeChecksums } from "./release-kit.ts";
import {
  expectedFiles,
  parseChecksums,
  parseUpdateMetadata,
  verifyRelease,
} from "./release-verify.ts";

const VERSION = "0.2.0-rc.1";

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

/** A complete, consistent release folder of small fixture files. */
async function writeRelease(version = VERSION): Promise<void> {
  const { required } = expectedFiles(version);
  const metadata = new Set(
    (["darwin", "win32", "linux"] as const).map((p) => desktopAssets(p, ["x64"], version).metadata),
  );
  for (const name of required) {
    if (metadata.has(name) || name === "SHA256SUMS" || name === "install.sh") continue;
    await writeFile(join(dir, name), `bytes of ${name}`);
  }
  await writeFile(join(dir, "install.sh"), 'set -e\nDEFAULT_REPO="acme/claudebot-fixture"\n');
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const archs = platform === "darwin" ? (["arm64", "x64"] as const) : (["x64"] as const);
    const { installers, metadata: name } = desktopAssets(platform, archs, version);
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
    required.filter((n) => n !== "SHA256SUMS"),
  );
}

describe("verifyRelease", () => {
  test("a complete consistent folder has no problems", async () => {
    await writeRelease();
    expect(await verifyRelease(dir, VERSION)).toEqual([]);
  });

  test("a tampered asset is a checksum mismatch", async () => {
    await writeRelease();
    await writeFile(join(dir, "claudebot-host-linux-x64"), "tampered");
    expect(await verifyRelease(dir, VERSION)).toEqual([
      "sha256 mismatch: claudebot-host-linux-x64 does not match SHA256SUMS",
    ]);
  });

  test("a missing asset is named, and SHA256SUMS still lists it", async () => {
    await writeRelease();
    await rm(join(dir, `Claudebot-${VERSION}.deb`));
    const problems = await verifyRelease(dir, VERSION);
    expect(problems).toContain(`missing: Claudebot-${VERSION}.deb`);
    expect(problems).toContain(
      `SHA256SUMS lists Claudebot-${VERSION}.deb, which is not in the folder`,
    );
  });

  test("a missing blockmap fails but the deb has none to miss", async () => {
    await writeRelease();
    await rm(join(dir, `Claudebot-Setup-${VERSION}.exe.blockmap`));
    expect(await verifyRelease(dir, VERSION)).toContain(
      `missing: Claudebot-Setup-${VERSION}.exe.blockmap`,
    );
  });

  test("another version's folder reports every asset as missing and unexpected", async () => {
    await writeRelease("0.1.0");
    const problems = await verifyRelease(dir, VERSION);
    expect(problems).toContain(`missing: Claudebot-Setup-${VERSION}.exe`);
    expect(problems).toContain("unexpected: Claudebot-Setup-0.1.0.exe");
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
    await writeFile(join(dir, "install.sh"), 'DEFAULT_REPO=""\n');
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
    expect(problems).toContain(`latest.yml does not list Claudebot-Setup-${VERSION}.exe`);
  });

  test("a malformed SHA256SUMS is reported, not skipped", async () => {
    await writeRelease();
    await writeFile(join(dir, "SHA256SUMS"), "not a checksum line\n");
    const problems = await verifyRelease(dir, VERSION);
    expect(problems[0]).toContain("line 1 is not");
    expect(problems).toContain("SHA256SUMS has no entry for install.sh");
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
