import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { setChatMode } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

const DAY = 24 * 60 * 60_000;
const TOOL = "mcp__fx__send_mail";
const INPUT = { to: "ana@example.com", body: "hi" };

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
const pages: EventsWatch[] = [];
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "background-tasks-routines-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
});
afterEach(async () => {
  pages.splice(0).forEach((p) => p.stop());
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

async function watch() {
  const page = await watchEvents(host);
  pages.push(page);
  const cards = (type: string) =>
    page.events().filter((e) => e.type === type) as { type: string; id: string }[];
  return { ...page, asks: () => cards("ask"), approvals: () => cards("approve") };
}

type Run = {
  id: string;
  status: string;
  error: string | null;
  output: string | null;
  sessionId: string | null;
};

/** A background-tasks bot with a routine, plus a second bot so the page can show either: the background-tasks bot's chat exists only when `chatOpen`. */
async function setup(
  chatOpen: boolean,
  schedule: object = { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
) {
  expect(
    (
      await host.ui("/api/integrations/add-custom", {
        name: "fx",
        url: `http://127.0.0.1:${mail.port}/mcp`,
        transport: "http",
      })
    ).status,
  ).toBe(200);
  const botId = host.createBot("Planner");
  setChatMode(host.dataRoot, botId, "background_tasks");
  const other = host.createBot("Other");
  const created = await host.ui("/api/routines/create", {
    botId,
    name: "nightly",
    instruction: "mail Ana",
    schedule,
  });
  const routineId = ((await created.json()) as { id: string }).id;
  const show = () => host.ui("/api/open", { botId: chatOpen ? botId : other });
  expect((await show()).status).toBe(200);
  return { botId, other, routineId, show };
}

const runs = async (routineId: string) =>
  (await (await host.ui("/api/routines/runs", { id: routineId })).json()) as Run[];
const latest = async (routineId: string) => (await runs(routineId))[0];
async function untilRun(routineId: string, status: string, ms = 5000) {
  for (let i = 0; i < ms / 25 && (await latest(routineId))?.status !== status; i++)
    await Bun.sleep(25);
  expect((await latest(routineId))?.status).toBe(status);
}
async function startRun(routineId: string) {
  const res = await host.ui("/api/routines/run", { id: routineId });
  expect(res.status).toBe(200);
}

/** The card of the parked request: shown live in a chat that is open, replayed when the owner opens a bot whose chat was closed. */
async function cardOf(
  chatOpen: boolean,
  botId: string,
  other: string,
  page: Awaited<ReturnType<typeof watch>>,
  kind: "approvals" | "asks",
) {
  if (!chatOpen) await host.ui("/api/open", { botId });
  await host.until(() => page[kind]().length > 0);
  const id = page[kind]().at(-1)!.id;
  if (!chatOpen) await host.ui("/api/open", { botId: other });
  return id;
}

const answer = (id: string, value: string) => host.ui("/api/answer", { id, value });
const resultMessages = (sessionId: string) =>
  host.messagesOf(sessionId).filter((m) => m.includes("<human-wait-result"));

describe.each([
  ["open", true],
  ["closed", false],
])("a background-tasks bot's routine run, its chat %s", (_label, chatOpen) => {
  test("an ask-policy tool parks the run; Allow resumes the run's own session and the front hears nothing of it", async () => {
    const { botId, other, routineId } = await setup(chatOpen);
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);

    await startRun(routineId);
    await untilRun(routineId, "waiting");
    const parked = (await latest(routineId))!;
    // The run has a session of its own: the front's session is the bot's first, which nothing was sent to.
    expect(parked.sessionId).not.toBeNull();
    expect(parked.sessionId).not.toBe(botId);
    const session = parked.sessionId!;
    await host.until(() => host.permissionResults().length === 1);
    expect(host.permissionResults()[0]).toMatchObject({
      tool_name: TOOL,
      response: { behavior: "deny" },
    });
    expect(host.messagesOf(session)).toHaveLength(1);
    expect(host.messagesOf(session)[0]).toContain("<scheduled-routine");
    expect(parked.output).toBeNull();

    const id = await cardOf(chatOpen, botId, other, page, "approvals");
    // The wait is stored under the run and the run's own session, not the front's.
    expect(
      host.db.query("SELECT run_id, session_id FROM human_waits WHERE id = ?").get(id),
    ).toEqual({ run_id: parked.id, session_id: session });
    expect((await answer(id, "allow")).status).toBe(200);
    await untilRun(routineId, "succeeded");

    // One resume message, in the same session, that is not the first prompt again.
    expect(host.messagesOf(session)).toHaveLength(2);
    const resume = host.messagesOf(session)[1]!;
    expect(resume).toContain(`<human-wait-result id="${id}">`);
    expect(resume).toContain("Call mcp__fx__send_mail again with exactly that input");
    expect(resume).not.toContain("<scheduled-routine");
    await host.until(() => host.permissionResults().length === 2);
    expect(host.permissionResults()[1]).toMatchObject({ response: { behavior: "allow" } });
    expect(await latest(routineId)).toMatchObject({ output: "ok", sessionId: session });

    // The run reports through its output; the front got neither the prompt nor the answer, and the chat shows no line of the run.
    expect(host.messagesOf(botId)).toEqual([]);
    expect(page.events().some((e) => e.type === "routine")).toBe(false);
    expect(await runs(routineId)).toHaveLength(1);
  });

  test("an ask_user question parks the run and its answer reaches the run's session", async () => {
    const { botId, other, routineId } = await setup(chatOpen);
    const page = await watch();
    host.askOnMessage("Which list?", ["List A", "List B"]);
    await startRun(routineId);
    await untilRun(routineId, "waiting");
    const session = (await latest(routineId))!.sessionId!;
    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()[0]).toContain("will arrive later as a message");

    const id = await cardOf(chatOpen, botId, other, page, "asks");
    expect(page.asks().at(-1)).toMatchObject({
      question: "Which list?",
      options: ["List A", "List B"],
    });
    host.stopAsking();
    expect((await answer(id, "List B")).status).toBe(200);
    await untilRun(routineId, "succeeded");
    expect(resultMessages(session)).toHaveLength(1);
    expect(resultMessages(session)[0]).toContain("Which list?");
    expect(resultMessages(session)[0]).toContain("List B");
    expect(host.messagesOf(botId)).toEqual([]);
  });

  test("an answer after restart() resumes the run in the same session", async () => {
    const { botId, other, routineId, show } = await setup(chatOpen);
    host.approveOnMessage(TOOL, INPUT);
    await startRun(routineId);
    await untilRun(routineId, "waiting");
    const session = (await latest(routineId))!.sessionId!;

    await host.restart();
    host.stopApproving();
    expect((await latest(routineId))?.status).toBe("waiting");
    const page = await watch();
    await show();
    const id = await cardOf(chatOpen, botId, other, page, "approvals");
    expect((await answer(id, "allow")).status).toBe(200);
    await untilRun(routineId, "succeeded");
    expect(resultMessages(session)).toHaveLength(1);
    expect(resultMessages(session)[0]).toContain("exactly that input");
    expect(host.messagesOf(session)).toHaveLength(2);
    expect((await latest(routineId))?.sessionId).toBe(session);
    expect(host.messagesOf(botId)).toEqual([]);
  });

  test("an answer to a question after restart() resumes the run", async () => {
    const { botId, other, routineId, show } = await setup(chatOpen);
    host.askOnMessage("Which list?");
    await startRun(routineId);
    await untilRun(routineId, "waiting");
    const session = (await latest(routineId))!.sessionId!;

    await host.restart();
    host.stopAsking();
    const page = await watch();
    await show();
    const id = await cardOf(chatOpen, botId, other, page, "asks");
    expect((await answer(id, "List A")).status).toBe(200);
    await untilRun(routineId, "succeeded");
    expect(resultMessages(session)[0]).toContain("List A");
    expect(host.messagesOf(botId)).toEqual([]);
  });

  test("24 hours later the park has expired: the run failed with 'approval expired' and the front is told nothing", async () => {
    const { botId, routineId } = await setup(chatOpen);
    host.approveOnMessage(TOOL, INPUT);
    await startRun(routineId);
    await untilRun(routineId, "waiting");

    host.stopApproving();
    host.advanceClock(DAY + 1000);
    await host.restart();
    await untilRun(routineId, "failed");
    expect((await latest(routineId))?.error).toBe("approval expired");
    await Bun.sleep(150);
    expect(host.messagesOf(botId)).toEqual([]);
    // The routine can run again, in a session of its own.
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
  });
});

describe("a background-tasks bot's front while a routine run is parked", () => {
  test("keeps answering, and a question it asks does not belong to the run", async () => {
    const { botId, routineId } = await setup(true);
    const page = await watch();
    host.askOnMessage("Which list?");
    await startRun(routineId);
    await untilRun(routineId, "waiting");
    const session = (await latest(routineId))!.sessionId!;
    await host.until(() => page.asks().length === 1);
    const runAsk = page.asks()[0]!.id;

    // The composer is not blocked by the parked run, and the front's own question is an attended one.
    host.askOnMessage("Front question?");
    expect((await host.ui("/api/send", { text: "status?" })).status).toBe(200);
    await host.until(() => page.asks().length === 2);
    const frontAsk = page.asks()[1]!.id;
    expect(host.messagesOf(botId)).toHaveLength(1);
    expect(host.messagesOf(botId)[0]).toContain("status?");

    expect((await answer(frontAsk, "whatever")).status).toBe(200);
    await Bun.sleep(150);
    expect((await latest(routineId))?.status).toBe("waiting");
    expect(host.messagesOf(session)).toHaveLength(1);

    host.stopAsking();
    expect((await answer(runAsk, "List A")).status).toBe(200);
    await untilRun(routineId, "succeeded");
    expect(resultMessages(session)).toHaveLength(1);
    expect(host.messagesOf(botId)).toHaveLength(1);
  });
});

describe("a background-tasks bot's routine run that asks for a takeover", () => {
  test("parks under the run's id and own session, and a hand-back resumes the run", async () => {
    const { botId, routineId } = await setup(true);
    expect((await host.ui("/api/bots/browser", { botId, enabled: true })).status).toBe(200);
    host.hold();
    await startRun(routineId);
    const first = defined(await latest(routineId), "run");
    const session = first.sessionId!;
    expect(session).not.toBe(botId);
    await host.until(() => host.messagesOf(session).length === 1);

    // The bot's browser call during the run, as the CLI would make it.
    const lease = defined(host.server.browser.lease(botId).servers[0], "browser server");
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(lease.url), {
        requestInit: { headers: { Authorization: `Bearer ${lease.token}` } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).not.toBe(true);
      return (r.content as { text: string }[]).map((c) => c.text).join("\n");
    };
    try {
      await call("browser_open", { url: "https://example.com" });
      const wait = JSON.parse(await call("browser_request_takeover", { reason: "solve it" })) as {
        status: string;
        id: string;
      };
      expect(wait.status).toBe("waiting_for_user");
      host.release();
      await untilRun(routineId, "waiting");
      expect(
        host.db.query("SELECT run_id, session_id FROM human_waits WHERE id = ?").get(wait.id),
      ).toEqual({ run_id: first.id, session_id: session });

      expect((await host.ui("/api/browser/control", { botId, action: "hand_back" })).status).toBe(
        200,
      );
      await untilRun(routineId, "succeeded");
      expect(host.messagesOf(session)).toHaveLength(2);
      expect(host.messagesOf(session)[1]).toContain("finished the takeover");
      expect(host.messagesOf(botId)).toEqual([]);
      expect(await runs(routineId)).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
