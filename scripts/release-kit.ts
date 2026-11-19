// The pure parts of the release workflow (`scripts/release.ts` is the command line around them): how a `v*` tag
// relates to the host's version, the SHA-256 checksum file that covers every published artifact, `release.json`, and
// the Ed25519 signature of the checksum file that a server verifies without trusting the download channel.
import {
  createPrivateKey,
  createPublicKey,
  createHash,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ReleaseManifest } from "../packages/contract/src/api.ts";

/** The checksum file every release publishes; `sha256sum --check` reads it. */
export const CHECKSUM_FILE = "SHA256SUMS";
/** The raw 64-byte Ed25519 signature of `SHA256SUMS`; it cannot be listed in the file it signs. */
export const SIGNATURE_FILE = "SHA256SUMS.sig";
/** What a release says about itself (`ReleaseManifest`); listed in `SHA256SUMS`, so the signature covers it. */
export const MANIFEST_FILE = "release.json";
/** The self-hoster's installer; its `RELEASE_PUBLIC_KEY` line is the one place the release public key is pinned. */
export const INSTALLER_FILE = "install.sh";

// The fixed prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the key itself is the 32 bytes after it.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PUBLIC_KEY_TEXT = /^[A-Za-z0-9+/]{43}=$/;

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
  const names = (await readdir(dir)).filter((n) => n !== CHECKSUM_FILE && n !== SIGNATURE_FILE);
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

/** Writes `release.json` into `dir`; the schema parse refuses a manifest a server could not read. */
export async function writeManifest(dir: string, manifest: ReleaseManifest): Promise<void> {
  const parsed = ReleaseManifest.parse(manifest);
  if (parsed.shellApi.min > parsed.shellApi.max) {
    throw new Error(`shellApi range ${parsed.shellApi.min}..${parsed.shellApi.max} is empty`);
  }
  await writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * The release public key an installer text pins: base64 of the 32 raw Ed25519 bytes on its `RELEASE_PUBLIC_KEY="…"`
 * line. Throws while the line is missing, empty (the owner has not pinned a key yet) or not a key, so nothing is
 * signed, verified or installed against a placeholder.
 */
export function parsePinnedKey(installer: string): string {
  const key = /^RELEASE_PUBLIC_KEY="([^"]*)"$/m.exec(installer)?.[1];
  if (key === undefined) throw new Error(`${INSTALLER_FILE} has no RELEASE_PUBLIC_KEY line`);
  if (key === "") {
    throw new Error(
      `no release public key is pinned: set RELEASE_PUBLIC_KEY in deploy/${INSTALLER_FILE} (docs/release/signing.md, "One-time setup")`,
    );
  }
  if (!PUBLIC_KEY_TEXT.test(key)) {
    throw new Error(
      `RELEASE_PUBLIC_KEY is not the base64 of 32 raw Ed25519 public key bytes: "${key}"`,
    );
  }
  return key;
}

/** The key pinned in this checkout's `deploy/install.sh`. */
export async function pinnedPublicKey(): Promise<string> {
  return parsePinnedKey(await readFile(join(import.meta.dir, "../deploy", INSTALLER_FILE), "utf8"));
}

function publicKeyObject(publicKey: string): KeyObject {
  if (!PUBLIC_KEY_TEXT.test(publicKey)) throw new Error("the public key is not a raw Ed25519 key");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, "base64")]),
    format: "der",
    type: "spki",
  });
}

/** Whether `signature` is `publicKey`'s Ed25519 signature of `message`. */
export function checkSignature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: string,
): boolean {
  return signature.length === 64 && verify(null, message, publicKeyObject(publicKey), signature);
}

/**
 * Signs `dir`'s `SHA256SUMS` with the PEM private key and writes `SHA256SUMS.sig`. The signature is checked against the
 * pinned public key before it is written, so a secret that is not the pinned key's pair fails the release instead of
 * shipping sums no server accepts.
 */
export async function signChecksums(
  dir: string,
  privateKeyPem: string,
  publicKey: string,
): Promise<void> {
  if (privateKeyPem.trim() === "") throw new Error("the release signing key is not set");
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("the release signing key is not Ed25519");
  const sums = await readFile(join(dir, CHECKSUM_FILE));
  const signature = sign(null, sums, key);
  if (!checkSignature(sums, signature, publicKey)) {
    throw new Error(
      "the release signing key does not belong to the public key pinned in deploy/install.sh",
    );
  }
  await writeFile(join(dir, SIGNATURE_FILE), signature);
}
