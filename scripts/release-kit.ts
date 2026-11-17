// The pure parts of the release workflow (`scripts/release.ts` is the command line around them): how a `v*` tag
// relates to the host's version, and the SHA-256 checksum file that covers every published artifact.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The checksum file every release publishes; `sha256sum --check` reads it. */
export const CHECKSUM_FILE = "SHA256SUMS";

/** The host binaries a release must ship, named as `scripts/build-host.ts` writes them. */
export const HOST_BINARIES = [
  "tomte-host-darwin-arm64",
  "tomte-host-darwin-x64",
  "tomte-host-linux-arm64",
  "tomte-host-linux-x64",
  "tomte-host-windows-x64.exe",
] as const;

// Semantic Versioning 2.0.0 without build metadata ("+" is not allowed in a release tag): vMAJOR.MINOR.PATCH[-pre.release].
const NUMBER = "(?:0|[1-9]\\d*)";
const IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const TAG = new RegExp(
  `^v(${NUMBER}\\.${NUMBER}\\.${NUMBER}(-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?)$`,
);

/** The version a tag names (without the `v`) and whether it is a pre-release (has a `-suffix`, e.g. `v1.2.0-rc.1`). */
export function parseTag(tag: string): { version: string; prerelease: boolean } {
  const match = TAG.exec(tag);
  if (!match?.[1]) {
    throw new Error(
      `the tag "${tag}" is not a release tag; expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-prerelease, e.g. v1.2.0 or v1.2.0-rc.1`,
    );
  }
  return { version: match[1], prerelease: match[2] !== undefined };
}

/** The tag's version when it equals the host's `VERSION`; throws otherwise, so a mismatched tag never releases. */
export function releaseForTag(
  tag: string,
  hostVersion: string,
): { version: string; prerelease: boolean } {
  const release = parseTag(tag);
  if (release.version !== hostVersion) {
    throw new Error(
      `the tag ${tag} says ${release.version} but the host reports ${hostVersion}; set VERSION in packages/host/src/harness/claude-access.ts to ${release.version}, commit, and tag that commit`,
    );
  }
  return release;
}

export function sha256(path: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const hash = createHash("sha256");
  createReadStream(path)
    .on("error", reject)
    .on("data", (chunk) => hash.update(chunk))
    .on("end", () => resolve(hash.digest("hex")));
  return promise;
}

/** `sha256sum` format: lowercase hex, two spaces, the bare file name; sorted by name so the file is reproducible. */
export function formatChecksums(entries: { name: string; sha256: string }[]): string {
  return entries
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${e.sha256}  ${e.name}\n`)
    .join("");
}

/**
 * Writes `SHA256SUMS` into `dir`, covering every file in it, and returns its text. Fails when `dir` holds anything
 * but plain files (a nested artifact folder would be skipped by `gh release upload` semantics) or lacks a file named
 * in `required`, so a release can never go out with an artifact missing from the checksums.
 */
export async function writeChecksums(dir: string, required: readonly string[]): Promise<string> {
  const names = (await readdir(dir)).filter((n) => n !== CHECKSUM_FILE);
  for (const name of names) {
    if (!(await stat(join(dir, name))).isFile())
      throw new Error(`${join(dir, name)} is not a file`);
  }
  const missing = required.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`missing from ${dir}: ${missing.join(", ")}`);
  const entries = await Promise.all(
    names.map(async (name) => ({ name, sha256: await sha256(join(dir, name)) })),
  );
  const text = formatChecksums(entries);
  await writeFile(join(dir, CHECKSUM_FILE), text);
  return text;
}
