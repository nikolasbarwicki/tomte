import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { HostConfig } from "./config.ts";
import { keychainSecrets, type SecretStore } from "./secrets.ts";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

/** The secrets file in the data root; one JSON document holding every secret. */
export const SECRETS_FILE = "secrets.enc";

/** The store `config.secrets` names; throws when the encrypted file cannot be opened with its key. */
export function openSecrets({ dataRoot, secrets }: HostConfig): SecretStore {
  return secrets.backend === "file" ? openFileSecrets(dataRoot, secrets.keyFile) : keychainSecrets;
}

const base64 = (bytes: number) =>
  z
    .string()
    .transform((s) => Buffer.from(s, "base64"))
    .refine((b) => b.length === bytes, `expected ${bytes} bytes`);

const sealed = z.object({
  iv: base64(IV_BYTES),
  tag: base64(TAG_BYTES),
  data: z.string().transform((s) => Buffer.from(s, "base64")),
});
type Sealed = z.infer<typeof sealed>;

const document = z.object({ version: z.literal(1), secrets: z.record(z.string(), sealed) });

function keyFileHint(keyFile: string): string {
  return `create one with: head -c ${KEY_BYTES} /dev/urandom > ${keyFile}; chmod 600 ${keyFile}`;
}

function readKey(keyFile: string): Buffer {
  let key: Buffer;
  try {
    key = readFileSync(keyFile);
  } catch (e) {
    throw new Error(
      `cannot read the secrets key file ${keyFile} (${(e as Error).message}); ${keyFileHint(keyFile)}`,
    );
  }
  if (key.length !== KEY_BYTES)
    throw new Error(
      `the secrets key file ${keyFile} holds ${key.length} bytes, but the key must be exactly ${KEY_BYTES} raw bytes; ${keyFileHint(keyFile)}`,
    );
  return key;
}

const seal = (key: Buffer, name: string, value: string): Sealed => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
};

/** Throws when the key is wrong, the value was altered, or it was moved to another name. */
const unseal = (key: Buffer, name: string, { iv, tag, data }: Sealed): string => {
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
};

function readSealed(file: string): Map<string, Sealed> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new Error(`cannot read the secrets file ${file}: ${(e as Error).message}`);
  }
  try {
    return new Map(Object.entries(document.parse(JSON.parse(text)).secrets));
  } catch {
    throw new Error(`the secrets file ${file} is not a tomte secrets file`);
  }
}

/** Writes a temporary file beside `file`, flushes it to disk, then renames it over `file`, so a crash leaves the old or the new contents, never a mix. */
async function writeAtomically(file: string, contents: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}

/**
 * Keeps every secret in `secrets.enc` in the data root, each value encrypted with AES-256-GCM under the 32 raw bytes in `keyFile`,
 * with a fresh IV per write and the secret's name as additional authenticated data. Opening decrypts every entry once, so a wrong
 * key or a damaged file fails here and not on a later read. Only this process writes the file; writes run one at a time.
 */
export function openFileSecrets(dataRoot: string, keyFile: string): SecretStore {
  const key = readKey(keyFile);
  const file = join(dataRoot, SECRETS_FILE);
  let entries = readSealed(file);
  for (const [name, entry] of entries) {
    try {
      unseal(key, name, entry);
    } catch {
      throw new Error(
        `cannot decrypt the secret "${name}" in ${file} with the key in ${keyFile}: the key is not the one that encrypted it, or the file was altered`,
      );
    }
  }

  let turn: Promise<unknown> = Promise.resolve();
  const update = async (edit: (next: Map<string, Sealed>) => boolean): Promise<void> => {
    const previous = turn;
    let done!: () => void;
    turn = new Promise<void>((resolve) => (done = resolve));
    await previous;
    try {
      const next = new Map(entries);
      if (!edit(next)) return;
      const secrets = Object.fromEntries(
        [...next].map(([name, e]) => [
          name,
          {
            iv: e.iv.toString("base64"),
            tag: e.tag.toString("base64"),
            data: e.data.toString("base64"),
          },
        ]),
      );
      await writeAtomically(file, JSON.stringify({ version: 1, secrets }));
      entries = next;
    } finally {
      done();
    }
  };

  return {
    get: async (name) => {
      const entry = entries.get(name);
      return entry ? unseal(key, name, entry) : null;
    },
    set: (name, value) =>
      update((next) => {
        next.set(name, seal(key, name, value));
        return true;
      }),
    delete: (name) => update((next) => next.delete(name)),
  };
}
