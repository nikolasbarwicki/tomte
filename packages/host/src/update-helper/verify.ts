import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ReleaseManifest } from "@tomte/contract/api";

/** A release that cannot be trusted, or cannot be fetched; the message is what the owner sees as the reason. */
export class ReleaseRejected extends Error {}

/** Downloads `url` to the file `dest`; throws when it cannot. The helper's only network access. */
export type Download = (url: string, dest: string) => Promise<void>;

export interface VerifiedRelease {
  manifest: ReleaseManifest;
  /** The checksum-verified host binary. */
  binary: string;
}

const SIGNATURE_BYTES = 64;
const SUMS = "SHA256SUMS";

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The checksum `SHA256SUMS` lists for `name`; a missing, repeated or malformed entry rejects the release. */
function listedChecksum(sums: string, name: string): string {
  const entries = sums
    .split("\n")
    .map((line) => /^([0-9A-Fa-f]{64}) [ *](.+)$/.exec(line))
    .filter((m) => m !== null && m[2] === name);
  if (entries.length !== 1)
    throw new ReleaseRejected(`SHA256SUMS lists ${name} ${entries.length} times, expected once`);
  return entries[0]![1]!.toLowerCase();
}

async function verifySignature(sums: string, signature: string, publicKey: string): Promise<void> {
  const sig = new Uint8Array(await readFile(signature));
  if (sig.length !== SIGNATURE_BYTES)
    throw new ReleaseRejected("the release signature is not 64 bytes");
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(publicKey, "base64"),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (!(await crypto.subtle.verify("Ed25519", key, sig, new Uint8Array(await readFile(sums)))))
    throw new ReleaseRejected(
      "the SHA256SUMS signature does not verify against the pinned release key",
    );
}

/**
 * Downloads `SHA256SUMS`, its signature, `release.json` and `asset` from `releaseUrl` into `dest` and trusts nothing until the
 * signature verifies against `publicKey` (base64 of the 32 raw Ed25519 bytes) and every file matches the signed sums; the format
 * is `deploy/install.sh`'s `download_verified_release`. `release.json` must name `version`. Throws `ReleaseRejected` otherwise.
 */
export async function fetchVerifiedRelease(o: {
  releaseUrl: string;
  dest: string;
  asset: string;
  version: string;
  publicKey: string;
  download: Download;
}): Promise<VerifiedRelease> {
  const path = (name: string) => join(o.dest, name);
  const fetch = async (name: string) => {
    try {
      await o.download(`${o.releaseUrl}/${name}`, path(name));
    } catch (e) {
      throw new ReleaseRejected(`could not download ${name}: ${(e as Error).message}`);
    }
  };
  await fetch(SUMS);
  await fetch(`${SUMS}.sig`);
  await verifySignature(path(SUMS), path(`${SUMS}.sig`), o.publicKey);
  const sums = await readFile(path(SUMS), "utf8");
  const verified = async (name: string) => {
    await fetch(name);
    const actual = await sha256(path(name));
    if (actual !== listedChecksum(sums, name))
      throw new ReleaseRejected(`${name} does not match the signed checksum`);
    return path(name);
  };
  const manifest = await verified("release.json").then(async (file) => {
    const parsed = ReleaseManifest.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) throw new ReleaseRejected("release.json is not a release manifest");
    return parsed.data;
  });
  if (manifest.version !== o.version)
    throw new ReleaseRejected(`the release says it is ${manifest.version}, not ${o.version}`);
  return { manifest, binary: await verified(o.asset) };
}
