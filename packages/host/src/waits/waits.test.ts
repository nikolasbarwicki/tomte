import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { defined } from "../testing/defined.ts";
import { parse, startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

const DAY = 24 * 60 * 60_000;
const TOOL = "mcp__fx__send_mail";

/** An integration whose one tool is destructive, which starts out on the `ask` policy. */
let mail: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  mail = Bun.serve({
    port: 0,
    async fetch(req) {
      const server = new McpServer({ name: "fixture", version: "1.0.0" });
      server.registerTool(
        "send_mail",
        { description: "Send an email", annotations: { destructiveHint: true } },
        async () => ({ content: [{ type: "text", text: "sent" }] }),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(req);
    },
  });
});

afterAll(() => mail.stop(true));

let host: HandoffHost;
let scratch: string;
const streams: AbortController[] = [];
const clients: Client[] = [];
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "waits-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
});
afterEach(async () => {
  streams.splice(0).forEach((s) => s.abort());
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

type PageEvent = { type: string; id?: string; [k: string]: unknown };

/** One page's `/api/events` stream from now on: what it is replayed on connecting, then what the host broadcasts. */
async function watch() {
  const stop = new AbortController();
  streams.push(stop);
  const res = await fetch(`${host.clientUrl}/api/events`, {
    signal: stop.signal,
    headers: host.authHeaders,
  });
  const seen: PageEvent[] = [];
  void (async () => {
    const reader = res.body!.getReader();
    let text = "";
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        text += new TextDecoder().decode(r.value);
        const parts = text.split("\n\n");
        text = parts.pop() ?? "";
        for (const p of parts) if (p.startsWith("data: ")) seen.push(...eventsOf(p.slice(6)));
      }
    } catch {
      // The test ended the stream.
    }
  })();
  const ofType = (type: string) => seen.filter((e) => e.type === type);
  return {
    events: () => seen,
    asks: () => ofType("ask") as (PageEvent & { id: string })[],
    approvals: () =>
      ofType("approve") as (PageEvent & { id: string; tool: string; input: string })[],
    waits: () => ofType("wait") as (PageEvent & { id: string; kind: string; actions: unknown[] })[],
  };
}

const answer = (id: string, value: string) => host.ui("/api/answer", { id, value });
const waitAnswer = (id: string, action: string) => host.ui("/api/waits/answer", { id, action });

async function openBot(name = "Planner") {
  const botId = host.createBot(name);
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  return botId;
}

/** The bot's browser tools, as the bot calls them. */
async function browserAs(botId: string) {
  expect((await host.ui("/api/bots/browser", { botId, enabled: true })).status).toBe(200);
  const s = defined(host.server.browser.lease(botId).servers[0], "server");
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(s.url), {
      requestInit: { headers: { Authorization: `Bearer ${s.token}` } },
    }),
  );
  clients.push(client);
  return (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }).then((r) => ({
      isError: r.isError === true,
      text: (r.content as { text: string }[]).map((c) => c.text).join("\n"),
    }));
}

const sent = (botId: string, tag: string) =>
  host.messagesOf(botId).filter((m) => m.includes(`<human-wait-result id="${tag}">`));

async function postQuestionEvent(botId: string) {
  const token = (
    (await (await host.ui("/api/bots/events-token", { botId })).json()) as { token: string }
  ).token;
  const res = await fetch(`${host.clientUrl}/api/bots/${botId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      kind: "question",
      key: "k1",
      source: { id: "auth-sso", label: "auth-sso" },
      title: "Which database?",
    }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { id: string }).id;
}

/** The open-item count the page shows for a bot. */
function needsYou(page: { events(): PageEvent[] }, botId: string) {
  const latest = page
    .events()
    .filter((e) => e.type === "bots")
    .at(-1) as (PageEvent & { bots: { id: string; needsYou: number }[] }) | undefined;
  return latest?.bots.find((b) => b.id === botId)?.needsYou ?? 0;
}

describe("tool approvals", () => {
  async function askingBot() {
    expect(
      (
        await host.ui("/api/integrations/add-custom", {
          name: "fx",
          url: `http://127.0.0.1:${mail.port}/mcp`,
          transport: "http",
        })
      ).status,
    ).toBe(200);
    return openBot();
  }

  test("a tool with the ask policy shows its input on a card; Allow and Deny each reach the tool", async () => {
    const botId = await askingBot();
    const page = await watch();
    host.approveOnMessage(TOOL, { to: "ana@example.com", body: "hi" });

    await host.ui("/api/send", { text: "mail her" });
    await host.until(() => page.approvals().length === 1);
    const card = page.approvals()[0]!;
    expect(card).toMatchObject({ tool: TOOL });
    expect(JSON.parse(card.input)).toEqual({ to: "ana@example.com", body: "hi" });
    expect(host.permissionResults()).toEqual([]);

    expect((await answer(card.id, "allow")).status).toBe(200);
    await host.until(() => host.permissionResults().length === 1);
    expect(host.permissionResults()[0]).toMatchObject({
      tool_name: TOOL,
      response: { behavior: "allow" },
    });
    expect(page.events()).toContainEqual({ type: "answered", id: card.id, value: "allow" });

    await host.until(() => host.messagesOf(botId).length === 1);
    await host.ui("/api/send", { text: "and again" });
    await host.until(() => page.approvals().length === 2);
    // The earlier Allow was spent on the call it answered; this call asks again.
    expect((await answer(page.approvals()[1]!.id, "deny")).status).toBe(200);
    await host.until(() => host.permissionResults().length === 2);
    expect(host.permissionResults()[1]).toMatchObject({
      response: { behavior: "deny", message: "user declined" },
    });
    // Nothing reached the session as a message: the tool call took both answers.
    expect(host.messagesOf(botId)).toEqual(["mail her", "and again"]);
  });

  test("an Allow after a restart covers one later call with exactly that input, whatever the key order, and no other", async () => {
    const botId = await askingBot();
    const first = await watch();
    host.approveOnMessage(TOOL, { to: "ana@example.com", body: "hi" });
    await host.ui("/api/send", { text: "mail her" });
    await host.until(() => first.approvals().length === 1);
    const card = first.approvals()[0]!;

    await host.restart();
    const page = await watch();
    await host.until(() => page.approvals().some((a) => a.id === card.id));

    // The bot's next call differs, so the Allow does not cover it.
    host.approveOnMessage(TOOL, { to: "bob@example.com", body: "hi" });
    expect((await answer(card.id, "allow")).status).toBe(200);
    await host.until(() => sent(botId, card.id).length === 1);
    expect(sent(botId, card.id)[0]).toContain(
      "Call mcp__fx__send_mail again with exactly that input",
    );
    await host.until(() => page.approvals().length === 2);
    const other = page.approvals()[1]!;
    expect(JSON.parse(other.input)).toEqual({ to: "bob@example.com", body: "hi" });
    expect(host.permissionResults()).toEqual([]);
    expect((await answer(other.id, "deny")).status).toBe(200);
    await host.until(() => host.permissionResults().length === 1);

    // The call the Allow was for (keys in another order) goes through once, with no card.
    host.approveOnMessage(TOOL, { body: "hi", to: "ana@example.com" });
    await host.ui("/api/send", { text: "again" });
    await host.until(() => host.permissionResults().length === 2);
    expect(host.permissionResults()[1]).toMatchObject({ response: { behavior: "allow" } });
    expect(page.approvals()).toHaveLength(2);

    // It was spent: the same call asks again.
    await host.ui("/api/send", { text: "once more" });
    await host.until(() => page.approvals().length === 3);
    expect(host.permissionResults()).toHaveLength(2);
  });
});

describe("questions", () => {
  test("an ask_user card survives a restart, and its answer then reaches the session as one message", async () => {
    const botId = await openBot();
    const before = await watch();
    host.askOnMessage("Which database?", ["Postgres", "SQLite"]);
    await host.ui("/api/send", { text: "hi" });
    await host.until(() => before.asks().length === 1);
    const ask = before.asks()[0]!;

    await host.restart();
    host.stopAsking();
    const page = await watch();
    await host.until(() => page.asks().some((a) => a.id === ask.id));
    expect(page.asks()[0]).toMatchObject({
      question: "Which database?",
      options: ["Postgres", "SQLite"],
    });
    expect(host.messagesOf(botId)).toEqual(["hi"]);

    expect((await answer(ask.id, "Postgres")).status).toBe(200);
    await host.until(() => host.messagesOf(botId).length === 2);
    expect(sent(botId, ask.id)).toHaveLength(1);
    expect(sent(botId, ask.id)[0]).toContain("Postgres");
    expect(page.events()).toContainEqual({ type: "answered", id: ask.id, value: "Postgres" });
    await Bun.sleep(150);
    expect(host.messagesOf(botId)).toHaveLength(2);

    expect((await answer(ask.id, "SQLite")).status).toBe(404);
  });

  test("a question about an external event does not outlive a restart, and answering it closes nothing", async () => {
    const botId = await openBot();
    const before = await watch();
    host.askOnMessage("Which database?", undefined, { delivered: true });
    const eventId = await postQuestionEvent(botId);
    await host.until(() => before.asks().length === 1);
    const ask = before.asks()[0]!;
    expect(ask.eventId).toBe(eventId);

    await host.restart();
    host.stopAsking();
    const page = await watch();
    await host.until(() => page.events().some((e) => e.type === "chat"));
    // The turn the question belonged to ended with the restart: nothing replays it, nothing tells the bot, the event stays open.
    await Bun.sleep(100);
    expect(page.asks()).toEqual([]);
    expect((await answer(ask.id, "Postgres")).status).toBe(404);
    expect(needsYou(page, botId)).toBe(1);
    expect(sent(botId, ask.id)).toHaveLength(0);
  });
});

describe("browser waits", () => {
  test("a takeover wait is cancelled by a restart and the bot is told its browser session is gone", async () => {
    const botId = await openBot();
    const call = await browserAs(botId);
    const wait = parse<{ id: string }>(
      await call("browser_request_takeover", { reason: "solve the CAPTCHA" }),
    );

    await host.restart();
    await host.until(() => sent(botId, wait.id).length === 1);
    expect(sent(botId, wait.id)[0]).toContain("cancelled");
    expect(sent(botId, wait.id)[0]).toContain("browser session is gone");
    expect((await waitAnswer(wait.id, "done")).status).toBe(404);
    const page = await watch();
    await Bun.sleep(100);
    expect(page.waits()).toEqual([]);
  });
});

describe("expiry", () => {
  test("a wait overdue by 24 hours expires at the next start and the bot is told", async () => {
    const botId = await openBot();
    const before = await watch();
    host.askOnMessage("Which database?");
    await host.ui("/api/send", { text: "hi" });
    await host.until(() => before.asks().length === 1);
    const ask = before.asks()[0]!;
    host.stopAsking();

    host.advanceClock(DAY - 1000);
    await host.restart();
    const stillOpen = await watch();
    await host.until(() => stillOpen.asks().some((a) => a.id === ask.id));
    expect(sent(botId, ask.id)).toHaveLength(0);

    host.advanceClock(2000);
    await host.restart();
    await host.until(() => sent(botId, ask.id).length === 1);
    expect(sent(botId, ask.id)[0]).toContain("expired after 24 hours");
    expect((await answer(ask.id, "Postgres")).status).toBe(404);
  });

  test("an answer that comes after the expiry is refused and the bot is told it expired", async () => {
    const botId = await openBot();
    const before = await watch();
    host.askOnMessage("Which database?");
    await host.ui("/api/send", { text: "hi" });
    await host.until(() => before.asks().length === 1);
    const ask = before.asks()[0]!;
    host.stopAsking();

    host.advanceClock(DAY + 1);
    expect((await answer(ask.id, "Postgres")).status).toBe(404);
    await host.until(() =>
      before.events().some((e) => e.type === "ask_expired" && e.id === ask.id),
    );
    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()[0]).toContain("expired after 24 hours");
    expect(sent(botId, ask.id)).toHaveLength(0);
  });
});

describe("deleting a bot and stale ids", () => {
  test("deleting a bot removes its waits", async () => {
    const botId = await openBot();
    const page = await watch();
    host.askOnMessage("Which database?");
    await host.ui("/api/send", { text: "hi" });
    await host.until(() => page.asks().length === 1);

    await host.server.removeBot(botId);
    // No other surface shows a closed wait, so the table is read directly.
    expect(host.db.query("SELECT COUNT(*) AS n FROM human_waits").get()).toEqual({ n: 0 });
  });

  test("each answer route refuses an unknown id and the other route's waits", async () => {
    const botId = await openBot();
    const call = await browserAs(botId);
    const takeover = parse<{ id: string }>(await call("browser_request_takeover", { reason: "x" }));
    const page = await watch();
    host.askOnMessage("Which database?");
    await host.ui("/api/send", { text: "hi" });
    await host.until(() => page.asks().length === 1);

    expect((await answer("no-such-wait", "allow")).status).toBe(404);
    expect((await waitAnswer("no-such-wait", "allow")).status).toBe(404);
    expect((await answer(takeover.id, "done")).status).toBe(404);
    expect((await waitAnswer(page.asks()[0]!.id, "Postgres")).status).toBe(404);
    expect((await waitAnswer(takeover.id, "skip")).status).toBe(200);
    expect((await waitAnswer(takeover.id, "skip")).status).toBe(404);
  });
});
