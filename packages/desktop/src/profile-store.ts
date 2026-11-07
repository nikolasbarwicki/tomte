import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { ConnectionError } from "./connection-error.ts";

/** The built-in profile for the host the app starts itself. It is never stored and never forgotten. */
export const LOCAL_ID = "local";

const StoredProfile = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  origin: z.string().min(1),
  deviceId: z.string().min(1),
  /** The device token encrypted by the vault, base64. */
  token: z.string().min(1),
});
type StoredProfile = z.infer<typeof StoredProfile>;

const ProfilesFile = z.object({ active: z.string(), profiles: z.array(StoredProfile) });

/** Encrypts device tokens with the operating system's credential store. There is no plaintext implementation. */
export interface TokenVault {
  /** Throws a `ConnectionError` when the store cannot protect a token, so a profile is refused instead of saved in the clear. */
  assertAvailable(): Promise<void>;
  encrypt(plain: string): Promise<string>;
  decrypt(encrypted: string): Promise<string>;
}

interface NewProfile {
  name: string;
  origin: string;
  deviceId: string;
  /** The plain device token; the store encrypts it before it reaches the file. */
  token: string;
}

export interface ProfileStore {
  /** The stored remote profiles, and the id the app connects to at startup (`LOCAL_ID` when that profile is gone). */
  read(): Promise<{ active: string; profiles: StoredProfile[] }>;
  add(profile: NewProfile): Promise<StoredProfile>;
  remove(id: string): Promise<void>;
  /** Throws a `ConnectionError` when a token cannot be stored safely; checked before pairing, so a refused profile leaves no device on the host. */
  assertCanStore(): Promise<void>;
  setActive(id: string): Promise<void>;
  /** The decrypted device token, held by the caller only for the request it makes. */
  token(id: string): Promise<string>;
}

/** `profiles.json` in the app's user-data folder. Every write is a temp file renamed over the old one, mode 0600, so a crash leaves the old file. */
export function createProfileStore(userData: string, vault: TokenVault): ProfileStore {
  const file = join(userData, "profiles.json");

  async function load(): Promise<{ active: string; profiles: StoredProfile[] }> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { active: LOCAL_ID, profiles: [] };
      throw error;
    }
    let parsed: z.infer<typeof ProfilesFile>;
    try {
      parsed = ProfilesFile.parse(JSON.parse(text));
    } catch {
      throw new ConnectionError(
        `The saved connections file is damaged (${file}). Move it away to start with an empty list.`,
      );
    }
    const known = parsed.profiles.some((p) => p.id === parsed.active);
    return { ...parsed, active: known ? parsed.active : LOCAL_ID };
  }

  async function save(data: z.infer<typeof ProfilesFile>): Promise<void> {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  return {
    read: load,
    assertCanStore: () => vault.assertAvailable(),

    async add(profile) {
      const data = await load();
      const stored: StoredProfile = {
        id: randomUUID(),
        name: profile.name,
        origin: profile.origin,
        deviceId: profile.deviceId,
        token: await vault.encrypt(profile.token),
      };
      await save({ ...data, profiles: [...data.profiles, stored] });
      return stored;
    },

    async remove(id) {
      const data = await load();
      await save({
        active: data.active === id ? LOCAL_ID : data.active,
        profiles: data.profiles.filter((p) => p.id !== id),
      });
    },

    async setActive(id) {
      const data = await load();
      if (data.active === id) return;
      if (id !== LOCAL_ID && !data.profiles.some((p) => p.id === id))
        throw new Error(`no profile ${id}`);
      await save({ ...data, active: id });
    },

    async token(id) {
      const profile = (await load()).profiles.find((p) => p.id === id);
      if (!profile) throw new ConnectionError("That connection no longer exists.");
      try {
        return await vault.decrypt(profile.token);
      } catch {
        throw new ConnectionError(
          `The saved device token for "${profile.name}" cannot be decrypted (the operating system's credential store changed). Forget this connection and add it again.`,
        );
      }
    },
  };
}
