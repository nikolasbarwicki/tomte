import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Built-in Gmail's token lifecycle on a whole host: the fake Claude CLI calls the in-process `gmail` server while the fake Google
// issues short-lived tokens, refuses a refresh or rejects a token. Connect goes through the HTTP routes.
import { defined } from "../testing/defined.ts";
import { fakeGoogle, type FakeGoogle } from "../testing/fake-google.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let google: FakeGoogle;

beforeEach(async () => {
  google = fakeGoogle();
  google.thread("t1", [
    { id: "m1", from: "Anna <anna@example.test>", subject: "Hi", text: "Hello" },
  ]);
  host = await startHandoffHost([], undefined, undefined, { google: google.endpoints });
});
afterEach(async () => {
  await host.stop();
  await google.stop();
});

type Card = { catalogId: string | null; state: string };

const card = async () => {
  const res = await host.ui("/api/integrations/list", {});
  const list = (await res.json()) as Card[];
  return defined(list.find((i) => i.catalogId === "gmail"));
};

async function connectGmail() {
  const start = await host.ui("/api/integrations/connect-oauth", {
    id: "catalog:gmail",
    clientId: google.client.id,
    clientSecret: google.client.secret,
  });
  const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
  const x = await google.approve(authorizeUrl);
  const back = await fetch(
    `${host.clientUrl}/oauth/callback?code=${x.code}&state=${encodeURIComponent(x.state)}`,
  );
  expect(back.status).toBe(200);
}

/** Opens a chat. "find the mail" searches Gmail through the in-process server; "again please" only asks permission to. */
async function openChat() {
  const id = host.createBot("Mail", "Reads the owner's mail");
  expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
  const search = {
    canUseTool: { tool_name: "mcp__gmail__search_threads", input: { query: "hi" } },
  };
  host.loopScript(
    {
      match: "find the mail",
      steps: [
        search,
        { mcp: { server: "gmail", tool: "search_threads", args: { query: "hi" } } },
        { result: "Done." },
      ],
    },
    { match: "again please", steps: [search, { result: "Denied." }] },
  );
  return id;
}

async function say(id: string, text: string) {
  expect((await host.ui("/api/send", { text })).status).toBe(200);
  await host.until(() => !host.server.isWorking(id));
}

const refreshes = () =>
  google.requests.filter((r) => r.kind === "token" && r.form?.grant_type === "refresh_token");

describe("Gmail past the first hour", () => {
  test("a tool call refreshes a token that is about to expire, and later calls use the new one", async () => {
    google.lifetime(60);
    await connectGmail();
    google.lifetime(3600);

    await say(await openChat(), "find the mail");

    expect(refreshes()).toHaveLength(1);
    expect(host.loopCalls()[0]?.result?.content[0]?.text).toContain("Hi");
    expect(google.gmail().map((r) => r.authorized)).toEqual([true, true]);
    expect((await card()).state).toBe("connected");
  });
});

describe("a grant that is gone", () => {
  test("invalid_grant puts the card in needs-sign-in, and the next tool call is denied", async () => {
    google.lifetime(60);
    await connectGmail();
    google.respond("POST /token", { status: 400, body: { error: "invalid_grant" } });
    const id = await openChat();

    await say(id, "find the mail");

    expect((await card()).state).toBe("needs-auth");
    expect(google.gmail()).toEqual([]);
    expect(host.loopCalls()[0]?.result?.content[0]?.text).toContain("sign in again");

    await say(id, "again please");
    await host.until(() => host.permissionResults().length === 2);
    expect(host.permissionResults().map((p) => p.response?.behavior)).toEqual(["allow", "deny"]);
    expect(google.gmail()).toEqual([]);
  });
});
