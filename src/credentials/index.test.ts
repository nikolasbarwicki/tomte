import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../platform/db.ts";
import { createCredentials, credentialApi, type Credentials } from "./index.ts";
import { credentialSecretName, memorySecrets } from "../platform/secrets.ts";

const PASSWORD = "hunter2-very-secret";
let db: Database;
let secrets: ReturnType<typeof memorySecrets>;
let creds: Credentials;
let changes: number;

beforeEach(() => {
  db = migrate(new Database(":memory:"));
  secrets = memorySecrets();
  changes = 0;
  creds = createCredentials({ db, secrets, onChange: () => changes++ });
});

const call = (path: string, body: Record<string, unknown>) => credentialApi(creds, `/api/credentials/${path}`, body);
const fields = { label: "GitHub", signInUrl: "https://github.com/login", username: "me", password: PASSWORD };
const addOk = async () => (await call("add", fields))!.body as { id: string };

test("add stores metadata with a derived origin and the password only in the secret store", async () => {
  const r = (await call("add", { ...fields, signInUrl: "https://github.com/login?x=1#frag" }))!;
  expect(r.status).toBe(200);
  const e = r.body as { id: string; origin: string; signInUrl: string };
  expect(e.origin).toBe("https://github.com");
  expect(e.signInUrl).toBe("https://github.com/login?x=1");
  expect(secrets.entries.get(credentialSecretName(e.id))).toBe(PASSWORD);
  const dump = JSON.stringify(db.query("SELECT * FROM credential_entries").all());
  expect(dump).not.toContain(PASSWORD);
});

test("no route response contains the password", async () => {
  const { id } = await addOk();
  const out = [
    JSON.stringify((await call("list", {}))!.body),
    JSON.stringify((await call("update", { ...fields, id, label: "GH", password: "new-secret-pw" }))!.body),
    JSON.stringify(creds.list()),
  ].join("");
  expect(out).not.toContain(PASSWORD);
  expect(out).not.toContain("new-secret-pw");
  expect(out).not.toContain("password");
});

test("sign-in URL must be https; http is allowed only for localhost", async () => {
  for (const signInUrl of ["http://example.com/login", "ftp://x.com", "not a url", "javascript:alert(1)", "https://u:p@example.com"]) {
    expect((await call("add", { ...fields, signInUrl }))!.status).toBe(400);
  }
  const ok = (await call("add", { ...fields, signInUrl: "http://localhost:3000/login" }))!;
  expect(ok.status).toBe(200);
  expect((ok.body as { origin: string }).origin).toBe("http://localhost:3000");
  expect(creds.list()).toHaveLength(1);
});

test("add requires a password and leaves nothing behind on rejection", async () => {
  expect((await call("add", { ...fields, password: "" }))!.status).toBe(400);
  expect((await call("add", { ...fields, signInUrl: "http://x.com", password: PASSWORD }))!.status).toBe(400);
  expect(creds.list()).toEqual([]);
  expect(secrets.entries.size).toBe(0);
});

test("update without a password keeps the stored one; with one replaces it; origin follows the URL", async () => {
  const { id } = await addOk();
  const keep = (await call("update", { id, label: "GH", signInUrl: "https://gitlab.com/users/sign_in", username: "you" }))!;
  expect(keep.body).toMatchObject({ label: "GH", origin: "https://gitlab.com", username: "you" });
  expect(secrets.entries.get(credentialSecretName(id))).toBe(PASSWORD);
  await call("update", { id, label: "GH", signInUrl: "https://gitlab.com/", username: "you", password: "p2" });
  expect(secrets.entries.get(credentialSecretName(id))).toBe("p2");
  expect((await call("update", { ...fields, id: "nope" }))!.status).toBe(404);
});

test("deleting an entry removes its grants and keychain item", async () => {
  const { id } = await addOk();
  const other = ((await call("add", { ...fields, label: "Other" }))!.body as { id: string }).id;
  creds.grant("bot-a", id);
  creds.grant("bot-b", id);
  creds.grant("bot-a", other);
  expect((await call("remove", { id }))!.status).toBe(200);
  expect(secrets.entries.has(credentialSecretName(id))).toBe(false);
  expect(db.query("SELECT * FROM credential_grants WHERE entry_id = ?").all(id)).toEqual([]);
  expect(creds.hasGrant("bot-a", other)).toBe(true);
  expect((await call("remove", { id }))!.status).toBe(404);
});

test("deleting a bot removes only its grants", async () => {
  const { id } = await addOk();
  creds.grant("bot-a", id);
  creds.grant("bot-b", id);
  creds.removeBot("bot-a");
  expect(creds.list()[0]!.grants.map((g) => g.botId)).toEqual(["bot-b"]);
});

test("grants are listed per entry and revocable; revoking twice is a 404", async () => {
  const { id } = await addOk();
  creds.grant("bot-a", id);
  creds.grant("bot-a", id);
  expect(creds.list()[0]!.grants).toHaveLength(1);
  expect((await call("revoke", { id, botId: "bot-a" }))!.status).toBe(200);
  expect(creds.hasGrant("bot-a", id)).toBe(false);
  expect((await call("revoke", { id, botId: "bot-a" }))!.status).toBe(404);
});

test("unknown routes are not handled and changes notify", async () => {
  expect(await call("bogus", {})).toBeUndefined();
  const before = changes;
  await addOk();
  expect(changes).toBe(before + 1);
});
