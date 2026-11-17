import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrate, openDb } from "../platform/db.ts";
import { memorySecrets } from "../platform/secrets.ts";
import { createWaits } from "../waits/index.ts";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A database at V27 as the vault left it: two entries, a grant, and a routine run parked on an open credential wait. */
function vaultDatabase(dataRoot: string) {
  const db = migrate(new Database(join(dataRoot, "tomte.db"), { create: true }));
  db.run(`CREATE TABLE credential_entries (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, sign_in_url TEXT NOT NULL, origin TEXT NOT NULL,
    username TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE credential_grants (
    bot_id TEXT NOT NULL, entry_id TEXT NOT NULL REFERENCES credential_entries(id) ON DELETE CASCADE,
    granted_at INTEGER NOT NULL, PRIMARY KEY (bot_id, entry_id))`);
  for (const id of ["e1", "e2"])
    db.query(
      "INSERT INTO credential_entries VALUES (?, ?, 'https://example.com/login', 'https://example.com', 'ada', 1, 1)",
    ).run(id, `Label ${id}`);
  db.run("INSERT INTO credential_grants VALUES ('bot', 'e1', 1)");
  db.run(`INSERT INTO routines (id, bot_id, name, instruction, schedule, active, catch_up, notify_result, created_at, updated_at)
    VALUES ('r', 'bot', 'n', 'i', '{"kind":"hourly","minute":0}', 1, 0, 0, 1, 1)`);
  db.run(`INSERT INTO routine_runs (id, routine_id, trigger, status, started_at, parked_at)
    VALUES ('run', 'r', 'manual', 'waiting', 1, 2)`);
  db.run(`INSERT INTO human_waits (id, bot_id, kind, run_id, payload, actions, created_at, expires_at)
    VALUES ('w', 'bot', 'credential', 'run', '{"entryId":"e2","label":"Label e2","origin":"https://example.com","botName":"Bot"}', '[]', 2, ${Date.now() + 60_000})`);
  db.run("PRAGMA user_version = 27");
  db.close();
}

test("opening a vault database deletes its passwords, closes its waits, fails the parked run and drops its tables", async () => {
  root = mkdtempSync(join(tmpdir(), "tomte-db-"));
  vaultDatabase(root);
  const secrets = memorySecrets();
  await secrets.set("browser-credential:e1", "pw1");
  await secrets.set("browser-credential:e2", "pw2");
  await secrets.set("integration:x", "kept");

  const db = await openDb(root, secrets);
  const waits = createWaits({ db, emit: () => {}, deliver: () => {}, context: () => ({}) });
  waits.start();
  waits.close();

  expect([...secrets.entries.keys()]).toEqual(["integration:x"]);
  expect(
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'credential_%'")
      .all(),
  ).toEqual([]);
  expect(
    db.query("SELECT state, outcome, delivered_at IS NOT NULL AS delivered FROM human_waits").get(),
  ).toEqual({
    state: "cancelled",
    outcome: "cancelled",
    delivered: 1,
  });
  expect(
    db.query("SELECT status, error, parked_at FROM routine_runs WHERE id = 'run'").get(),
  ).toEqual({
    status: "failed",
    error: "the credential vault was removed",
    parked_at: null,
  });
  expect(waits.list("bot").filter((w) => w.state === "open")).toEqual([]);
  db.close();
});

test("a password that cannot be deleted does not stop the database from opening", async () => {
  root = mkdtempSync(join(tmpdir(), "tomte-db-"));
  vaultDatabase(root);
  const secrets = memorySecrets();
  const failing = {
    ...secrets,
    delete: async (name: string) => {
      if (name === "browser-credential:e1") throw new Error("keychain locked");
      await secrets.delete(name);
    },
  };
  await secrets.set("browser-credential:e1", "pw1");
  await secrets.set("browser-credential:e2", "pw2");

  const db = await openDb(root, failing);
  expect([...secrets.entries.keys()]).toEqual(["browser-credential:e1"]);
  expect(
    db.query("SELECT name FROM sqlite_master WHERE name = 'credential_entries'").all(),
  ).toEqual([]);
  db.close();
});

test("a database without the vault opens with nothing to sweep", async () => {
  root = mkdtempSync(join(tmpdir(), "tomte-db-"));
  const secrets = memorySecrets();
  await secrets.set("integration:x", "kept");
  (await openDb(root, secrets)).close();
  const db = await openDb(root, secrets);
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(
    28,
  );
  expect([...secrets.entries.keys()]).toEqual(["integration:x"]);
  db.close();
});
