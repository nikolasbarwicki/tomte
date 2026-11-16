import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHECKSUM_FILE,
  formatChecksums,
  parseTag,
  releaseForTag,
  writeChecksums,
} from "./release-kit.ts";

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
