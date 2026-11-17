import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { CredentialEntry } from "@tomte/contract/events";
import { z } from "zod";

import { InvalidInput, NotFound } from "../platform/errors.ts";
import { credentialSecretName, type SecretStore } from "../platform/secrets.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The sign-in URL must be https (http only for localhost, or anywhere when `allowHttp`, for testing); returns the normalized URL and its origin. */
function parseSignInUrl(raw: string, allowHttp = false): { url: string; origin: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new InvalidInput("Sign-in URL is not a valid URL");
  }
  const ok =
    u.protocol === "https:" ||
    (u.protocol === "http:" && (allowHttp || LOCAL_HOSTS.has(u.hostname)));
  if (!ok) throw new InvalidInput("Sign-in URL must use https");
  if (u.username || u.password) throw new InvalidInput("Sign-in URL must not contain credentials");
  u.hash = "";
  return { url: u.href, origin: u.origin };
}

/** HTTP-boundary schema; `password` is required on add and optional (never pre-filled) on edit. */
export const CredentialFields = z.object({
  label: z.string().trim().min(1, "Label is required"),
  signInUrl: z.string(),
  username: z.string().trim().min(1, "Username is required"),
});

type EntryRow = {
  id: string;
  label: string;
  sign_in_url: string;
  origin: string;
  username: string;
  created_at: number;
  updated_at: number;
};
type GrantRow = { bot_id: string; entry_id: string; granted_at: number };

export function createCredentials(deps: {
  db: Database;
  secrets: SecretStore;
  now?: () => number;
  onChange?: () => void;
  /** Test-only: accept plain-http sign-in URLs on any host (the browser smoke's site is on a LAN IP). */
  allowHttp?: boolean;
}) {
  const { db, secrets } = deps;
  const now = deps.now ?? Date.now;
  const changed = () => deps.onChange?.();

  const list = (): CredentialEntry[] => {
    const grants = db
      .query<GrantRow, []>("SELECT * FROM credential_grants ORDER BY granted_at, rowid")
      .all();
    return db
      .query<EntryRow, []>("SELECT * FROM credential_entries ORDER BY created_at, rowid")
      .all()
      .map((r) => ({
        id: r.id,
        label: r.label,
        signInUrl: r.sign_in_url,
        origin: r.origin,
        username: r.username,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        grants: grants
          .filter((g) => g.entry_id === r.id)
          .map((g) => ({ botId: g.bot_id, grantedAt: g.granted_at })),
      }));
  };
  const get = (id: string) => list().find((e) => e.id === id);
  const need = (id: string) =>
    get(id) ??
    (() => {
      throw new NotFound("No such credential");
    })();

  return {
    list,
    get,

    async add(
      f: z.infer<typeof CredentialFields> & { password: string },
    ): Promise<CredentialEntry> {
      const v = CredentialFields.parse(f);
      if (!f.password) throw new InvalidInput("Password is required");
      const { url, origin } = parseSignInUrl(v.signInUrl, deps.allowHttp);
      const id = randomUUID();
      const t = now();
      await secrets.set(credentialSecretName(id), f.password);
      try {
        db.query(
          "INSERT INTO credential_entries (id, label, sign_in_url, origin, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(id, v.label, url, origin, v.username, t, t);
      } catch (e) {
        await secrets.delete(credentialSecretName(id));
        throw e;
      }
      changed();
      return need(id);
    },

    /** An omitted or empty password keeps the stored one. */
    async update(
      id: string,
      f: z.infer<typeof CredentialFields> & { password?: string },
    ): Promise<CredentialEntry> {
      need(id);
      const v = CredentialFields.parse(f);
      const { url, origin } = parseSignInUrl(v.signInUrl, deps.allowHttp);
      if (f.password) await secrets.set(credentialSecretName(id), f.password);
      db.query(
        "UPDATE credential_entries SET label = ?, sign_in_url = ?, origin = ?, username = ?, updated_at = ? WHERE id = ?",
      ).run(v.label, url, origin, v.username, now(), id);
      changed();
      return need(id);
    },

    /** Deletes the entry, its grants (cascade) and its keychain item. */
    async remove(id: string) {
      need(id);
      db.query("DELETE FROM credential_entries WHERE id = ?").run(id);
      await secrets.delete(credentialSecretName(id));
      changed();
    },

    grant(botId: string, entryId: string) {
      need(entryId);
      db.query(
        "INSERT OR IGNORE INTO credential_grants (bot_id, entry_id, granted_at) VALUES (?, ?, ?)",
      ).run(botId, entryId, now());
      changed();
    },

    revoke(botId: string, entryId: string) {
      if (
        db
          .query("DELETE FROM credential_grants WHERE bot_id = ? AND entry_id = ?")
          .run(botId, entryId).changes === 0
      )
        throw new NotFound("No such grant");
      changed();
    },

    /** Called when a bot is deleted. */
    removeBot(botId: string) {
      if (db.query("DELETE FROM credential_grants WHERE bot_id = ?").run(botId).changes > 0)
        changed();
    },

    hasGrant: (botId: string, entryId: string) =>
      !!db
        .query("SELECT 1 FROM credential_grants WHERE bot_id = ? AND entry_id = ?")
        .get(botId, entryId),
  };
}

export type Credentials = ReturnType<typeof createCredentials>;
