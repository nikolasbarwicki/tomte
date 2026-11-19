import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { World } from "../testing/update-world.ts";
import { fetchVerifiedRelease, ReleaseRejected } from "./verify.ts";

let w: World;
beforeEach(() => {
  w = new World();
  w.publish({ version: "0.2.0" });
});
afterEach(() => w.dispose());

/** Fetches 0.2.0 into a fresh folder, after `edit` changed the published files. */
async function fetchWith(edit: (published: string) => void = () => {}, key = w.publicKey) {
  const published = join(w.releases, "v0.2.0");
  edit(published);
  const dest = join(w.root, "dest");
  mkdirSync(dest, { recursive: true });
  return fetchVerifiedRelease({
    releaseUrl: "https://releases.test/owner/tomte/releases/download/v0.2.0",
    dest,
    asset: "tomte-host-linux-x64",
    version: "0.2.0",
    publicKey: key,
    download: async (url, to) => {
      copyFileSync(join(published, url.slice(url.lastIndexOf("/") + 1)), to);
    },
  });
}

describe("fetchVerifiedRelease", () => {
  test("returns the manifest and the checksummed binary", async () => {
    const r = await fetchWith();
    expect(r.manifest).toEqual({
      version: "0.2.0",
      shellApi: { min: 1, max: 1 },
      schemaVersion: 7,
    });
    expect(JSON.parse(readFileSync(r.binary, "utf8")).version).toBe("0.2.0");
  });

  test.each([
    [
      "a signature of the wrong length",
      (p: string) => writeFileSync(join(p, "SHA256SUMS.sig"), "short"),
      "not 64 bytes",
    ],
    [
      "a SHA256SUMS edited after signing",
      (p: string) =>
        writeFileSync(join(p, "SHA256SUMS"), `${"0".repeat(64)}  tomte-host-linux-x64\n`),
      "does not verify",
    ],
    [
      "a release.json edited after signing",
      (p: string) => writeFileSync(join(p, "release.json"), "{}"),
      "does not match the signed checksum",
    ],
  ])("%s is rejected", async (_name, edit, message) => {
    await expect(fetchWith(edit)).rejects.toThrow(message);
    await expect(fetchWith(edit)).rejects.toThrow(ReleaseRejected);
  });

  test.each([
    [
      "no entry for the binary",
      { sums: (s: string) => s.split("\n").slice(0, 1).join("\n") + "\n" },
      "0 times",
    ],
    ["two entries for the binary", { sums: (s: string) => s + s.split("\n")[1] + "\n" }, "2 times"],
    [
      "a release.json that is not a manifest",
      { manifest: '{"version":"0.2.0"}' },
      "not a release manifest",
    ],
  ])("a signed release with %s is rejected", async (_name, release, message) => {
    w.publish({ version: "0.2.0", ...release });
    await expect(fetchWith()).rejects.toThrow(message);
  });

  test("a different pinned key rejects an otherwise valid release", async () => {
    const other = new World();
    try {
      await expect(fetchWith(() => {}, other.publicKey)).rejects.toThrow("does not verify");
    } finally {
      other.dispose();
    }
  });

  test("a download failure names the file", async () => {
    const dest = join(w.root, "dest2");
    mkdirSync(dest);
    await expect(
      fetchVerifiedRelease({
        releaseUrl: "https://releases.test/x",
        dest,
        asset: "a",
        version: "0.2.0",
        publicKey: w.publicKey,
        download: async () => {
          throw new Error("connection reset");
        },
      }),
    ).rejects.toThrow("could not download SHA256SUMS: connection reset");
  });
});
