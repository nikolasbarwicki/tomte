import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseTooNew, migrate, openDb, SCHEMA_VERSION, snapshotDatabase } from "./db.ts";
import { memorySecrets } from "./secrets.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "db-version-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const version = (db: Database) =>
  db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;

/** A database file a newer binary would have written: this binary's schema, then one version more. */
function newerDatabase(by = 1) {
  const db = migrate(new Database(join(root, "tomte.db"), { create: true }));
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION + by}`);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

/** The files beside the database and the bytes of the database and its log; the shared-memory index is only a cache SQLite rebuilds on every open. */
const snapshot = () => ({
  files: readdirSync(root),
  database: readFileSync(join(root, "tomte.db")).toString("hex"),
  log: existsSync(join(root, "tomte.db-wal")) ? readFileSync(join(root, "tomte.db-wal")).length : 0,
});

test("a database past the latest known version is refused with both versions, and the file is left as it was", async () => {
  newerDatabase();
  const before = snapshot();

  const error = await openDb(root, memorySecrets()).then(
    () => undefined,
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(DatabaseTooNew);
  const message = (error as Error).message;
  expect(message).toContain(`version ${SCHEMA_VERSION + 1}`);
  expect(message).toContain(`version ${SCHEMA_VERSION} this host knows`);
  expect(message).toMatch(/update the host/i);
  expect(message).toMatch(/restore/i);
  expect(snapshot()).toEqual(before);
});

test("migrate refuses a newer database and leaves its version and tables alone", () => {
  const db = migrate(new Database(":memory:"));
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 3}`);
  const tables = db.query("SELECT name FROM sqlite_master ORDER BY name").all();

  expect(() => migrate(db)).toThrow(DatabaseTooNew);

  expect(version(db)).toBe(SCHEMA_VERSION + 3);
  expect(db.query("SELECT name FROM sqlite_master ORDER BY name").all()).toEqual(tables);
});

test("a database at the latest version opens as it is", async () => {
  migrate(new Database(join(root, "tomte.db"), { create: true })).close();

  const db = await openDb(root, memorySecrets());

  expect(version(db)).toBe(SCHEMA_VERSION);
  db.close();
});

test("a database below the latest version migrates up to it, and a new one starts from nothing", async () => {
  const old = migrate(new Database(join(root, "tomte.db"), { create: true }));
  old.run("DROP TABLE chat_origins");
  old.run("PRAGMA user_version = 28");
  old.close();

  const db = await openDb(root, memorySecrets());
  expect(version(db)).toBe(SCHEMA_VERSION);
  expect(db.query("SELECT COUNT(*) AS n FROM chat_origins").get()).toEqual({ n: 0 });
  db.close();

  const fresh = await openDb(join(root, "fresh"), memorySecrets());
  expect(version(fresh)).toBe(SCHEMA_VERSION);
  fresh.close();
});

test("a snapshot is the database as it was, private, complete without its write-ahead log, and replaced by the next one", async () => {
  const db = await openDb(root, memorySecrets());
  db.run("CREATE TABLE note (text TEXT)");
  db.run("INSERT INTO note VALUES ('before')");
  const path = join(root, "updates", "pre-0.2.0.db");
  snapshotDatabase(db, path);
  db.run("INSERT INTO note VALUES ('after')");

  const copy = new Database(path, { readonly: true });
  expect(version(copy)).toBe(SCHEMA_VERSION);
  expect(copy.query("SELECT text FROM note").all()).toEqual([{ text: "before" }]);
  copy.close();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(root, "updates"))).toEqual(["pre-0.2.0.db"]);

  snapshotDatabase(db, path);
  const again = new Database(path, { readonly: true });
  expect(again.query("SELECT count(*) AS n FROM note").get()).toEqual({ n: 2 });
  again.close();
  db.close();
});
