import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConnectionError } from "./connection-error.ts";
import { createProfileStore, LOCAL_ID, type TokenVault } from "./profile-store.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-profiles-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Prefixes and base64-encodes, so a stored value is recognisably not the plain token. */
const vault: TokenVault & { available: boolean } = {
  available: true,
  async assertAvailable() {
    if (!this.available) throw new ConnectionError("no credential store");
  },
  async encrypt(plain) {
    return Buffer.from(`enc:${plain}`).toString("base64");
  },
  async decrypt(encrypted) {
    if (encrypted === "bad") throw new Error("key changed");
    return Buffer.from(encrypted, "base64").toString().slice(4);
  },
};

const file = () => join(dir, "profiles.json");
const NEW = {
  name: "Work",
  origin: "https://work.example.com",
  deviceId: "dev-1",
  token: "s3cret-token",
};

describe("createProfileStore", () => {
  test("starts empty and active on local when there is no file", async () => {
    expect(await createProfileStore(dir, vault).read()).toEqual({ active: LOCAL_ID, profiles: [] });
  });

  test("keeps the device id in clear and the token encrypted, in a 0600 file", async () => {
    const store = createProfileStore(dir, vault);
    const added = await store.add(NEW);
    const raw = readFileSync(file(), "utf8");
    expect(raw).toContain("dev-1");
    expect(raw).not.toContain("s3cret-token");
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["profiles.json"]);
    expect(await store.token(added.id)).toBe("s3cret-token");
    expect((await store.read()).profiles[0]).toMatchObject({ name: "Work", origin: NEW.origin });
  });

  test("remembers the active profile and falls back to local when it is removed", async () => {
    const store = createProfileStore(dir, vault);
    const a = await store.add(NEW);
    const b = await store.add({ ...NEW, name: "Home", origin: "https://home.example.com" });
    await store.setActive(b.id);
    expect((await createProfileStore(dir, vault).read()).active).toBe(b.id);
    await store.remove(b.id);
    expect(await store.read()).toMatchObject({ active: LOCAL_ID, profiles: [{ id: a.id }] });
    await expect(store.setActive("nope")).rejects.toThrow("no profile nope");
  });

  test("reads an active id that names no profile as local", async () => {
    writeFileSync(file(), JSON.stringify({ active: "ghost", profiles: [] }));
    expect((await createProfileStore(dir, vault).read()).active).toBe(LOCAL_ID);
  });

  test("refuses a damaged file instead of replacing it", async () => {
    for (const text of ["{not json", JSON.stringify({ active: "local" })]) {
      writeFileSync(file(), text);
      const store = createProfileStore(dir, vault);
      await expect(store.read()).rejects.toThrow(ConnectionError);
      await expect(store.add(NEW)).rejects.toThrow(ConnectionError);
      expect(readFileSync(file(), "utf8")).toBe(text);
    }
  });

  test("reports a token that cannot be decrypted as a message to the user", async () => {
    writeFileSync(
      file(),
      JSON.stringify({
        active: LOCAL_ID,
        profiles: [{ id: "p", name: "Work", origin: NEW.origin, deviceId: "d", token: "bad" }],
      }),
    );
    await expect(createProfileStore(dir, vault).token("p")).rejects.toThrow(/cannot be decrypted/);
    await expect(createProfileStore(dir, vault).token("missing")).rejects.toThrow(ConnectionError);
  });

  test("asks the vault whether a token can be stored", async () => {
    const store = createProfileStore(dir, vault);
    await store.assertCanStore();
    vault.available = false;
    await expect(store.assertCanStore()).rejects.toThrow("no credential store");
    vault.available = true;
  });
});
