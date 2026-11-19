import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { migrate } from "../platform/db.ts";
import { InvalidInput } from "../platform/errors.ts";
import { memorySecrets, secretName, type SecretStore } from "../platform/secrets.ts";
import { defined } from "../testing/defined.ts";
import { fakeGoogle, type FakeGoogle } from "../testing/fake-google.ts";
import { CATALOG } from "./catalog.ts";
import { createIntegrations, type Integrations, type ServerName } from "./index.ts";

// The built-in Gmail token lifecycle at the integrations-module seam: `createIntegrations` against the loopback fake Google, tools
// called over an in-memory MCP link the way the CLI calls the in-process server.

const REDIRECT = "http://127.0.0.1:9/oauth/callback";
const HOUR = 3_600_000;
const SEARCH = "GET /gmail/v1/users/me/threads";

let google: FakeGoogle;
let integrations: Integrations;
let secrets: SecretStore;
let clock: number;
let changes: number;
const clients: Client[] = [];

beforeEach(() => {
  google = fakeGoogle();
  secrets = memorySecrets();
  clock = Date.UTC(2026, 10, 18);
  changes = 0;
  integrations = createIntegrations({
    db: migrate(new Database(":memory:")),
    secrets,
    hostDir: mkdtempSync(join(tmpdir(), "tomte-gmail-token-")),
    now: () => clock,
    onChange: () => changes++,
    oauthRedirectUrl: REDIRECT,
    google: google.endpoints,
    log: () => {},
  });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await google.stop();
});

const card = () => defined(integrations.list().find((i) => i.catalogId === "gmail"));

async function signIn(id = card().id, own?: { clientId: string; clientSecret: string }) {
  const { authorizeUrl } = await integrations.connectOAuth(id, own);
  const x = await google.approve(authorizeUrl);
  return integrations.finishOAuth(x.state, { code: x.code });
}
const signInWithClient = () =>
  signIn(card().id, { clientId: google.client.id, clientSecret: google.client.secret });

async function callSearch() {
  const server = defined((await integrations.session()).builtinServers["gmail" as ServerName]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(far);
  const client = new Client({ name: "test", version: "1.0.0" });
  clients.push(client);
  await client.connect(near);
  const r = await client.callTool({ name: "search_threads", arguments: {} });
  return {
    isError: r.isError === true,
    text: (r.content as { text: string }[]).map((c) => c.text).join("\n"),
  };
}

const stored = async () =>
  JSON.parse((await secrets.get(secretName(card().id))) ?? "{}") as {
    oauth?: {
      client?: { client_id: string };
      tokens?: { access_token: string; refresh_token?: string };
      expiresAt?: number;
    };
  };
const tokenRequests = () => google.requests.filter((r) => r.kind === "token");
const refreshes = () => tokenRequests().filter((r) => r.form?.grant_type === "refresh_token");

describe("a token near its expiry", () => {
  test("is refreshed with the stored refresh token, written back and used for the call", async () => {
    await signInWithClient();
    const before = await stored();
    expect((await callSearch()).isError).toBe(false);
    expect(refreshes()).toHaveLength(0);

    clock += HOUR - 4 * 60_000;
    expect((await callSearch()).isError).toBe(false);

    expect(refreshes()).toHaveLength(1);
    expect(refreshes()[0]?.form).toMatchObject({
      refresh_token: before.oauth?.tokens?.refresh_token,
      client_id: google.client.id,
      client_secret: google.client.secret,
    });
    const after = await stored();
    expect(after.oauth?.tokens?.access_token).not.toBe(before.oauth?.tokens?.access_token);
    expect(after.oauth?.tokens?.refresh_token).toBe(before.oauth?.tokens?.refresh_token);
    expect(after.oauth?.expiresAt).toBe(clock + HOUR);
    expect(google.gmail().at(-1)).toMatchObject({
      authorization: `Bearer ${after.oauth?.tokens?.access_token}`,
      authorized: true,
    });
    expect(card().state).toBe("connected");
  });

  test("is not refreshed while it has more than the margin left", async () => {
    await signInWithClient();
    clock += HOUR - 6 * 60_000;
    await callSearch();
    expect(refreshes()).toHaveLength(0);
  });

  test("makes one token request for concurrent calls, and every call is authorized", async () => {
    await signInWithClient();
    clock += HOUR;
    const results = await Promise.all([callSearch(), callSearch(), callSearch(), callSearch()]);

    expect(results.map((r) => r.isError)).toEqual([false, false, false, false]);
    expect(refreshes()).toHaveLength(1);
    expect(google.gmail()).toHaveLength(4);
    expect(google.gmail().every((r) => r.authorized)).toBe(true);
  });

  test("a failed refresh is not remembered: the next call asks Google again", async () => {
    await signInWithClient();
    clock += HOUR;
    google.respond("POST /token", { status: 503, body: { error: "backend_error" } });
    const failed = await callSearch();
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("backend_error");
    expect(card().state).toBe("connected");
    expect((await stored()).oauth?.tokens?.refresh_token).toBeTruthy();

    expect((await callSearch()).isError).toBe(false);
    expect(refreshes()).toHaveLength(2);
  });
});

describe("a grant that is gone", () => {
  test("invalid_grant on refresh puts the card in needs-auth, drops the tokens, keeps the client and denies the tools", async () => {
    await signInWithClient();
    clock += HOUR;
    google.respond("POST /token", { status: 400, body: { error: "invalid_grant" } });
    const changed = changes;

    const r = await callSearch();

    expect(r.isError).toBe(true);
    expect(r.text).toContain("sign in again");
    expect(google.gmail()).toHaveLength(0);
    expect(card().state).toBe("needs-auth");
    expect(changes).toBeGreaterThan(changed);
    expect(await stored()).toEqual({ oauth: { client: expect.objectContaining({}) } });
    expect((await stored()).oauth?.client?.client_id).toBe(google.client.id);
    expect(integrations.decide("mcp__gmail__search_threads")).toBe("deny");
    expect((await integrations.session()).builtinServers).toEqual({});
    await expect(integrations.probe(card().id)).rejects.toThrow(InvalidInput);
    expect(card().state).toBe("needs-auth");
  });

  test("a 401 that survives a refresh puts the card in needs-auth", async () => {
    await signInWithClient();
    google.respond(SEARCH, { status: 401, body: {} }, 2);

    const r = await callSearch();

    expect(r.isError).toBe(true);
    expect(refreshes()).toHaveLength(1);
    expect(google.gmail()).toHaveLength(2);
    expect(card().state).toBe("needs-auth");
    expect(integrations.decide("mcp__gmail__search_threads")).toBe("deny");
  });

  test("a revoked access token is replaced through a refresh and the call is repeated once, still connected", async () => {
    await signInWithClient();
    google.revokeAccessTokens();

    const r = await callSearch();

    expect(r.isError).toBe(false);
    expect(refreshes()).toHaveLength(1);
    expect(google.gmail().map((x) => x.status)).toEqual([401, 200]);
    expect(google.gmail().map((x) => x.authorized)).toEqual([false, true]);
    expect(card().state).toBe("connected");
  });

  test("a 403 for insufficient scope puts the card in needs-auth", async () => {
    await signInWithClient();
    google.respond(SEARCH, {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          errors: [{ message: "Insufficient Permission", reason: "insufficientPermissions" }],
        },
      },
    });

    const r = await callSearch();

    expect(r.isError).toBe(true);
    expect(r.text).toContain("insufficient authentication scopes");
    expect(refreshes()).toHaveLength(0);
    expect(card().state).toBe("needs-auth");
    expect(integrations.decide("mcp__gmail__search_threads")).toBe("deny");
  });

  test("any other 403 is a tool error that leaves the card connected", async () => {
    await signInWithClient();
    google.respond(SEARCH, {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Rate Limit Exceeded",
          errors: [{ message: "Rate Limit Exceeded", reason: "rateLimitExceeded" }],
        },
      },
    });

    expect((await callSearch()).isError).toBe(true);
    expect(card().state).toBe("connected");
    expect(integrations.decide("mcp__gmail__search_threads")).toBe("allow");
  });

  test("a new sign-in after needs-auth connects again without entering the client", async () => {
    await signInWithClient();
    clock += HOUR;
    google.respond("POST /token", { status: 400, body: { error: "invalid_grant" } });
    await callSearch();
    expect(card().state).toBe("needs-auth");

    expect((await signIn()).state).toBe("connected");
    expect((await callSearch()).isError).toBe(false);
  });
});

describe("disconnect", () => {
  test("removes the tokens and keeps the client, so Gmail connects again with empty fields", async () => {
    await signInWithClient();
    await integrations.disconnect(card().id);

    expect(card().state).toBe("disconnected");
    const left = await stored();
    expect(left.oauth?.tokens).toBeUndefined();
    expect(left.oauth?.client?.client_id).toBe(google.client.id);
    expect(JSON.stringify(integrations.list())).not.toContain(google.client.secret);
    expect((await integrations.session()).builtinServers).toEqual({});

    expect((await signIn()).state).toBe("connected");
  });

  test("another Google entry signs in with the client Gmail held, after Gmail disconnects", async () => {
    const gmail = defined(CATALOG.find((c) => c.id === "gmail"));
    integrations = createIntegrations({
      db: migrate(new Database(":memory:")),
      secrets,
      hostDir: mkdtempSync(join(tmpdir(), "tomte-gmail-token-")),
      now: () => clock,
      onChange: () => {},
      oauthRedirectUrl: REDIRECT,
      google: google.endpoints,
      log: () => {},
      catalog: [gmail, { ...gmail, id: "gmail2", label: "Second Google service" }],
    });
    await signInWithClient();
    await integrations.disconnect(card().id);

    const second = defined(integrations.list().find((i) => i.catalogId === "gmail2"));
    const connected = await signIn(second.id);

    expect(connected.state).toBe("connected");
    const exchange = tokenRequests().at(-1);
    expect(exchange?.form).toMatchObject({
      client_id: google.client.id,
      client_secret: google.client.secret,
    });
  });

  test("remove deletes the whole entry", async () => {
    await signInWithClient();
    await integrations.remove(card().id);
    expect(await secrets.get(secretName("catalog:gmail"))).toBeNull();
  });
});
