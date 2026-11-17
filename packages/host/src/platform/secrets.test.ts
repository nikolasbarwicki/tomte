import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openFileSecrets, SECRETS_FILE } from "./file-secrets.ts";
import { memorySecrets, type SecretStore } from "./secrets.ts";

let root: string;
let keyFile: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomte-secrets-"));
  keyFile = join(root, "secrets.key");
  writeFileSync(keyFile, crypto.getRandomValues(new Uint8Array(32)), { mode: 0o600 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const secretsFile = () => join(root, SECRETS_FILE);

const stores: [string, () => SecretStore][] = [
  ["memory", () => memorySecrets()],
  ["file", () => openFileSecrets(root, keyFile)],
];

describe.each(stores)("%s store", (_name, open) => {
  test("get returns what set stored, and null for a name never set", async () => {
    const store = open();
    expect(await store.get("integration:a")).toBeNull();
    await store.set("integration:a", '{"token":"t-1"}');
    await store.set("integration:b", "second");
    expect(await store.get("integration:a")).toBe('{"token":"t-1"}');
    expect(await store.get("integration:b")).toBe("second");
  });

  test("set overwrites the earlier value", async () => {
    const store = open();
    await store.set("name", "old");
    await store.set("name", "new, with ünïcode ✓");
    expect(await store.get("name")).toBe("new, with ünïcode ✓");
  });

  test("delete removes one name, leaves the others, and tolerates a missing name", async () => {
    const store = open();
    await store.set("keep", "k");
    await store.set("drop", "d");
    await store.delete("drop");
    await store.delete("never-set");
    expect(await store.get("drop")).toBeNull();
    expect(await store.get("keep")).toBe("k");
  });

  test("concurrent writes lose no update", async () => {
    const store = open();
    const names = Array.from({ length: 25 }, (_, i) => `secret:${i}`);
    await Promise.all(names.map((n) => store.set(n, `value-of-${n}`)));
    await Promise.all(names.filter((_, i) => i % 5 === 0).map((n) => store.delete(n)));
    for (const [i, n] of names.entries())
      expect(await store.get(n)).toBe(i % 5 === 0 ? null : `value-of-${n}`);
  });
});

describe("file store", () => {
  const VALUE = "synthetic-password-9f3a1c";
  const NAME = "integration:abc";

  test("a store reopened with the same key reads the old values and sees deletions", async () => {
    const first = openFileSecrets(root, keyFile);
    await first.set(NAME, VALUE);
    await first.set("gone", "x");
    await first.delete("gone");
    const again = openFileSecrets(root, keyFile);
    expect(await again.get(NAME)).toBe(VALUE);
    expect(await again.get("gone")).toBeNull();
  });

  test("a store opened with a different key fails instead of returning garbage", async () => {
    await openFileSecrets(root, keyFile).set(NAME, VALUE);
    const other = join(root, "other.key");
    writeFileSync(other, crypto.getRandomValues(new Uint8Array(32)));
    expect(() => openFileSecrets(root, other)).toThrow(/cannot decrypt.*other\.key/);
  });

  test("the file holds no plaintext value, and names only beside ciphertext", async () => {
    const store = openFileSecrets(root, keyFile);
    await store.set(NAME, VALUE);
    await store.set("integration:x", JSON.stringify({ accessToken: "at-secret-77", other: VALUE }));
    const bytes = readFileSync(secretsFile()).toString("latin1");
    for (const plain of [
      VALUE,
      "at-secret-77",
      "accessToken",
      `${NAME}:${VALUE}`,
      `"${NAME}":"${VALUE}"`,
    ])
      expect(bytes).not.toContain(plain);
  });

  test("the file is private and no temporary file is left behind", async () => {
    const store = openFileSecrets(root, keyFile);
    await store.set("a", "1");
    await store.set("b", "2");
    if (process.platform !== "win32") expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a write that cannot replace the file rejects and leaves no temporary file behind", async () => {
    const store = openFileSecrets(root, keyFile);
    mkdirSync(join(secretsFile(), "blocker"), { recursive: true });
    await expect(store.set("a", "1")).rejects.toThrow();
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("each write uses a fresh IV, so rewriting a value changes its ciphertext", async () => {
    const store = openFileSecrets(root, keyFile);
    await store.set("a", "same");
    const before = readFileSync(secretsFile(), "utf8");
    await store.set("a", "same");
    expect(readFileSync(secretsFile(), "utf8")).not.toBe(before);
  });

  test("a value moved to another name is refused when the store opens", async () => {
    await openFileSecrets(root, keyFile).set("integration:a", "tok");
    const doc = JSON.parse(readFileSync(secretsFile(), "utf8"));
    doc.secrets["integration:b"] = doc.secrets["integration:a"];
    delete doc.secrets["integration:a"];
    writeFileSync(secretsFile(), JSON.stringify(doc));
    expect(() => openFileSecrets(root, keyFile)).toThrow(
      /cannot decrypt the secret "integration:b"/,
    );
  });

  test("a tampered value is refused when the store opens", async () => {
    await openFileSecrets(root, keyFile).set("a", "tok");
    const doc = JSON.parse(readFileSync(secretsFile(), "utf8"));
    doc.secrets.a.data = Buffer.from("forged!").toString("base64");
    writeFileSync(secretsFile(), JSON.stringify(doc));
    expect(() => openFileSecrets(root, keyFile)).toThrow(/cannot decrypt/);
  });

  test("a file that is not a secrets file is refused", () => {
    writeFileSync(secretsFile(), "not json");
    expect(() => openFileSecrets(root, keyFile)).toThrow(/not a tomte secrets file/);
  });

  test("opening writes nothing", () => {
    openFileSecrets(root, keyFile);
    expect(existsSync(secretsFile())).toBe(false);
  });

  test.each([
    ["missing", undefined],
    ["31 bytes", 31],
    ["33 bytes", 33],
    ["empty", 0],
  ])("a key file that is %s is refused with its path and how to create one", (_label, size) => {
    const bad = join(root, "bad.key");
    if (size !== undefined) writeFileSync(bad, new Uint8Array(size));
    expect(() => openFileSecrets(root, bad)).toThrow(
      new RegExp(
        `${bad.replaceAll("\\", "\\\\")}.*head -c 32 /dev/urandom > ${bad.replaceAll("\\", "\\\\")}; chmod 600`,
      ),
    );
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable key file is refused",
    () => {
      chmodSync(keyFile, 0o000);
      expect(() => openFileSecrets(root, keyFile)).toThrow(/cannot read the secrets key file/);
    },
  );
});
