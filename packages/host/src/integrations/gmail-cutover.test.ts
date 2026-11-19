import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The secret half of the Gmail cutover: openDb takes the hosted sign-in's tokens out of the secret store while the row is still hosted,
// keeps the owner's Google client, and the converted card then signs in with that client without it being typed again.
import { migrate, openDb } from "../platform/db.ts";
import { memorySecrets, secretName, type SecretStore } from "../platform/secrets.ts";
import { defined } from "../testing/defined.ts";
import { fakeGoogle, type FakeGoogle } from "../testing/fake-google.ts";
import { createIntegrations } from "./index.ts";

const ID = "catalog:gmail";
const HOSTED_TOKENS = {
  access_token: "ya29.hosted",
  refresh_token: "1//hosted",
  token_type: "Bearer",
};

let scratch: string;
let google: FakeGoogle;
/** The owner's Google client, the one the fake Google knows. */
let ownerClient: { client_id: string; client_secret: string };

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "gmail-cutover-"));
  mkdirSync(scratch, { recursive: true });
  google = fakeGoogle();
  ownerClient = { client_id: google.client.id, client_secret: google.client.secret };
});
afterEach(async () => {
  await google.stop();
  rmSync(scratch, { recursive: true, force: true });
});

function hostedDatabase() {
  const db = migrate(new Database(join(scratch, "tomte.db"), { create: true }));
  db.query(
    `INSERT INTO integrations (id, catalog_id, name, transport, auth, enabled, state, error, created_at, updated_at)
     VALUES (?, 'gmail', 'gmail', ?, '{"kind":"none"}', 1, 'connected', NULL, 1, 1)`,
  ).run(ID, JSON.stringify({ type: "http", url: "https://hosted.example.test/mcp" }));
  db.query(`INSERT INTO integration_tools VALUES (?, 'search_threads', '', 1, 0, 'off', 1)`).run(
    ID,
  );
  db.run("PRAGMA user_version = 29");
  db.close();
}

const hostedSecret = (extra: object = {}) =>
  JSON.stringify({
    oauth: {
      client: ownerClient,
      tokens: HOSTED_TOKENS,
      expiresAt: Date.now() + 3_600_000,
      ...extra,
    },
  });

const integrationsOn = (db: Database, secrets: SecretStore) =>
  createIntegrations({
    db,
    secrets,
    hostDir: scratch,
    onChange: () => {},
    oauthRedirectUrl: "http://127.0.0.1:9/oauth/callback",
    google: google.endpoints,
    log: () => {},
  });

test("the hosted tokens are removed, the owner's client stays and the converted card signs in without it being typed again", async () => {
  hostedDatabase();
  const secrets = memorySecrets();
  await secrets.set(secretName(ID), hostedSecret());
  await secrets.set(secretName("other"), "kept");

  const db = await openDb(scratch, secrets);
  expect(JSON.parse(defined(secrets.entries.get(secretName(ID))))).toEqual({
    oauth: { client: ownerClient },
  });
  expect(secrets.entries.get(secretName("other"))).toBe("kept");

  const integrations = integrationsOn(db, secrets);
  const card = defined(integrations.list().find((i) => i.catalogId === "gmail"));
  expect(card).toMatchObject({ state: "needs-auth", transport: { type: "builtin" } });
  const session = await integrations.session();
  expect(session.builtinServers).toEqual({});

  const { authorizeUrl } = await integrations.connectOAuth(ID);
  expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe(ownerClient.client_id);
  const x = await google.approve(authorizeUrl);
  const signedIn = await integrations.finishOAuth(x.state, { code: x.code });
  expect(signedIn.state).toBe("connected");
  expect(signedIn.tools.find((t) => t.name === "search_threads")?.policy).toBe("off");
  expect(JSON.stringify(secrets.entries.get(secretName(ID)))).not.toContain("hosted");
  db.close();
});

test("opening the database again does not touch a sign-in made on the built-in server", async () => {
  hostedDatabase();
  const secrets = memorySecrets();
  await secrets.set(secretName(ID), hostedSecret());
  (await openDb(scratch, secrets)).close();
  const signedIn = JSON.stringify({
    oauth: { client: ownerClient, tokens: { ...HOSTED_TOKENS, access_token: "ya29.new" } },
  });
  await secrets.set(secretName(ID), signedIn);

  (await openDb(scratch, secrets)).close();
  expect(secrets.entries.get(secretName(ID))).toBe(signedIn);
});

test("a hosted entry that holds no client is deleted", async () => {
  hostedDatabase();
  const secrets = memorySecrets();
  await secrets.set(secretName(ID), JSON.stringify({ oauth: { tokens: HOSTED_TOKENS } }));
  (await openDb(scratch, secrets)).close();
  expect(secrets.entries.has(secretName(ID))).toBe(false);
});

test("a secret that cannot be rewritten is logged without its contents and does not stop the database from opening", async () => {
  hostedDatabase();
  const secrets = memorySecrets();
  await secrets.set(secretName(ID), hostedSecret());
  const failing = {
    ...secrets,
    set: async () => {
      throw new Error("keychain locked");
    },
  };
  const logged: string[] = [];
  const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logged.push(a.join(" "));
  });
  try {
    const db = await openDb(scratch, failing);
    expect(db.query("SELECT state, transport FROM integrations").get()).toEqual({
      state: "needs-auth",
      transport: JSON.stringify({ type: "builtin", service: "gmail" }),
    });
    db.close();
  } finally {
    err.mockRestore();
  }
  expect(logged.join("\n")).toContain("keychain locked");
  expect(logged.join("\n")).not.toContain("ya29");
});
