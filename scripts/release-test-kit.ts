// A throwaway Ed25519 release key for tests. Never a real key: the real private key is a repository secret and its
// public half is pinned in deploy/install.sh.
import { generateKeyPairSync } from "node:crypto";

export interface TestKey {
  /** PKCS#8 PEM, the format of the `RELEASE_SIGNING_KEY` secret. */
  privateKeyPem: string;
  /** Base64 of the 32 raw public key bytes, the format `RELEASE_PUBLIC_KEY` pins. */
  publicKey: string;
}

export function generateTestKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    // An Ed25519 SubjectPublicKeyInfo is a 12-byte prefix and then the 32 raw key bytes.
    publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64"),
  };
}
