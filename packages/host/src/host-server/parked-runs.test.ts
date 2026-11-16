import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

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
const streams: AbortController[] = [];
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "parked-runs-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
});
afterEach(async () => {
  streams.splice(0).forEach((s) => s.abort());
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

type PageEvent = { type: string; id?: string; [k: string]: unknown };

/** One page's `/api/events` stream from now on. */
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
        for (const p of parts) if (p.startsWith("data: ")) seen.push(JSON.parse(p.slice(6)));
      }
    } catch {
      // The test ended the stream.
    }
  })();
  return {
    events: () => seen,
    asks: () => seen.filter((e) => e.type === "ask") as (PageEvent & { id: string })[],
    approvals: () => seen.filter((e) => e.type === "approve") as (PageEvent & { id: string })[],
  };
}

type Run = {
  id: string;
  status: string;
  error: string | null;
  output: string | null;
  costUsd: number | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  parkedMs: number;
};

describe.each([
  ["chat-hosted", true],
  ["headless", false],
])("%s routine run", (_label, chatHosted) => {
  /** A bot with the ask-policy tool and a routine, plus a second bot so the page always has a chat open: the first bot's chat exists only when `chatHosted`. */
  async function setup(schedule: object = { kind: "cron", expr: "0 3 * * *", tz: "UTC" }) {
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
    const other = host.createBot("Other");
    const created = await host.ui("/api/routines/create", {
      botId,
      name: "nightly",
      instruction: "mail Ana",
      schedule,
    });
    const routineId = ((await created.json()) as { id: string }).id;
    const show = () => host.ui("/api/open", { botId: chatHosted ? botId : other });
    expect((await show()).status).toBe(200);
    return { botId, other, routineId, show };
  }

  const runs = async (routineId: string) =>
    (await (await host.ui("/api/routines/runs", { id: routineId })).json()) as Run[];
  const latest = async (routineId: string) => (await runs(routineId))[0];
  const statusIs = (routineId: string, status: string) => async () =>
    (await latest(routineId))?.status === status;
  const untilRun = async (routineId: string, status: string, ms = 5000) => {
    for (let i = 0; i < ms / 25 && !(await statusIs(routineId, status)()); i++) await Bun.sleep(25);
    expect((await latest(routineId))?.status).toBe(status);
  };
  const startRun = async (routineId: string) => {
    const res = await host.ui("/api/routines/run", { id: routineId });
    expect(res.status).toBe(200);
    return (await res.json()) as Run;
  };

  /** The card of the bot's parked request: shown live in a chat that is open, replayed from the table when the owner opens the bot. A headless bot's chat is closed again so the answer resumes headless. */
  async function cardOf(
    botId: string,
    other: string,
    page: Awaited<ReturnType<typeof watch>>,
    kind: "approvals" | "asks",
  ) {
    const seen = () => page[kind]();
    if (!chatHosted) await host.ui("/api/open", { botId });
    await host.until(() => seen().length > 0);
    const id = seen().at(-1)!.id;
    if (!chatHosted) await host.ui("/api/open", { botId: other });
    return id;
  }

  const answer = (id: string, value: string) => host.ui("/api/answer", { id, value });
  const resultMessages = (botId: string) =>
    host.messagesOf(botId).filter((m) => m.includes("<human-wait-result"));

  test("an ask-policy tool parks the run; Allow resumes the same session with one message and the run succeeds", async () => {
    const { botId, other, routineId } = await setup();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);

    await startRun(routineId);
    await untilRun(routineId, "waiting");
    // The bot was refused for now and told to end its turn; the run's first message is the only one it has had.
    await host.until(() => host.permissionResults().length === 1);
    expect(host.permissionResults()[0]).toMatchObject({
      tool_name: TOOL,
      response: { behavior: "deny" },
    });
    expect(host.permissionResults()[0]?.response?.message).toContain("sent to the owner");
    expect(host.messagesOf(botId)).toHaveLength(1);
    expect(host.messagesOf(botId)[0]).toContain("<scheduled-routine");
    expect((await latest(routineId))?.output).toBeNull();

    const id = await cardOf(botId, other, page, "approvals");
    expect((await answer(id, "allow")).status).toBe(200);
    await untilRun(routineId, "succeeded");

    // One resume message, in the same session, that is not the first prompt again.
    expect(host.messagesOf(botId)).toHaveLength(2);
    const resume = host.messagesOf(botId)[1]!;
    expect(resume).toContain(`<human-wait-result id="${id}">`);
    expect(resume).toContain("Call mcp__fx__send_mail again with exactly that input");
    expect(resume).not.toContain("<scheduled-routine");
    // The bot's repeat of the call (the fake asks on every message) is the input the owner allowed, so it goes through.
    await host.until(() => host.permissionResults().length === 2);
    expect(host.permissionResults()[1]).toMatchObject({ response: { behavior: "allow" } });
    expect(await runs(routineId)).toHaveLength(1);
  });

  test("a run that parks and resumes adds both turns' usage to one row and records how long it waited", async () => {
    const { botId, other, routineId } = await setup();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);
    host.setUsage({ cost: 0.5, input: 1000, output: 100 });
    await startRun(routineId);
    await untilRun(routineId, "waiting");
    const id = await cardOf(botId, other, page, "approvals");
    await Bun.sleep(40);
    expect((await latest(routineId))?.parkedMs).toBeGreaterThanOrEqual(40);

    host.setUsage({ cost: 0.8, input: 1600, output: 160 });
    expect((await answer(id, "allow")).status).toBe(200);
    await untilRun(routineId, "succeeded");

    const [run, ...rest] = await runs(routineId);
    expect(rest).toEqual([]);
    expect(run?.costUsd).toBeCloseTo(0.8);
    expect(run?.usage).toMatchObject({ inputTokens: 1600, outputTokens: 160 });
    expect(run?.parkedMs).toBeGreaterThanOrEqual(40);
  });

  test("Deny reaches the bot and the run finishes", async () => {
    const { botId, other, routineId } = await setup();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);
    await startRun(routineId);
    await untilRun(routineId, "waiting");

    const id = await cardOf(botId, other, page, "approvals");
    host.stopApproving();
    expect((await answer(id, "deny")).status).toBe(200);
    await untilRun(routineId, "succeeded");
    expect(resultMessages(botId)).toHaveLength(1);
    expect(resultMessages(botId)[0]).toContain("The user denied mcp__fx__send_mail");
    expect(resultMessages(botId)[0]).toContain("Do not retry");
  });

  test("an unattended ask_user parks the run and its answer reaches the bot", async () => {
    const { botId, other, routineId } = await setup();
    const page = await watch();
    host.askOnMessage("Which list?", ["List A", "List B"]);
    await startRun(routineId);
    await untilRun(routineId, "waiting");
    await host.until(() => host.toolResults().length === 1);
    // The bot's call returned at once, saying the answer will come as a message.
    expect(host.toolResults()[0]).toContain("will arrive later as a message");

    const id = await cardOf(botId, other, page, "asks");
    expect(page.asks().at(-1)).toMatchObject({
      question: "Which list?",
      options: ["List A", "List B"],
    });
    host.stopAsking();
    expect((await answer(id, "List B")).status).toBe(200);
    await untilRun(routineId, "succeeded");
    expect(resultMessages(botId)).toHaveLength(1);
    expect(resultMessages(botId)[0]).toContain("Which list?");
    expect(resultMessages(botId)[0]).toContain("List B");
  });

  test("an answer given while the first turn still runs does not park the run", async () => {
    const { botId, other, routineId } = await setup();
    const page = await watch();
    host.hold();
    host.askOnMessage("Which list?");
    await startRun(routineId);
    await host.until(() => host.toolResults().length === 1);

    const id = await cardOf(botId, other, page, "asks");
    expect((await answer(id, "List A")).status).toBe(200);
    expect((await latest(routineId))?.status).toBe("running");
    expect(host.messagesOf(botId)).toHaveLength(1);

    host.stopAsking();
    host.release();
    const seen = new Set<string>();
    for (let i = 0; i < 200 && !seen.has("succeeded"); i++) {
      seen.add((await latest(routineId))?.status ?? "");
      await Bun.sleep(10);
    }
    expect(seen.has("succeeded")).toBe(true);
    expect(seen.has("waiting")).toBe(false);
    expect(resultMessages(botId)).toHaveLength(1);
    expect(resultMessages(botId)[0]).toContain("List A");
  });

  test("an answer after restart() resumes the run", async () => {
    const { botId, other, routineId, show } = await setup();
    host.approveOnMessage(TOOL, INPUT);
    await startRun(routineId);
    await untilRun(routineId, "waiting");

    await host.restart();
    host.stopApproving();
    expect((await latest(routineId))?.status).toBe("waiting");
    const page = await watch();
    await show();
    const id = await cardOf(botId, other, page, "approvals");
    expect((await answer(id, "allow")).status).toBe(200);
    await untilRun(routineId, "succeeded");
    expect(resultMessages(botId)).toHaveLength(1);
    expect(resultMessages(botId)[0]).toContain("exactly that input");
    expect(host.messagesOf(botId)).toHaveLength(2);
  });

  test("an answer to a question after restart() resumes the run", async () => {
    const { botId, other, routineId, show } = await setup();
    host.askOnMessage("Which list?");
    await startRun(routineId);
    await untilRun(routineId, "waiting");

    await host.restart();
    host.stopAsking();
    const page = await watch();
    await show();
    const id = await cardOf(botId, other, page, "asks");
    expect((await answer(id, "List A")).status).toBe(200);
    await untilRun(routineId, "succeeded");
    expect(resultMessages(botId)[0]).toContain("List A");
  });

  test("24 hours later the park has expired: the run failed with 'approval expired', and the bot is told that nothing was approved", async () => {
    const { botId, routineId } = await setup();
    host.approveOnMessage(TOOL, INPUT);
    await startRun(routineId);
    await untilRun(routineId, "waiting");

    host.stopApproving();
    host.advanceClock(DAY + 1000);
    await host.restart();
    await untilRun(routineId, "failed");
    expect((await latest(routineId))?.error).toBe("approval expired");
    await host.until(() => resultMessages(botId).length === 1);
    expect(resultMessages(botId)[0]).toContain("expired");
    expect(resultMessages(botId)[0]).toContain("nothing was approved");
    expect(resultMessages(botId)[0]).toContain("Do not retry");
    // The routine can run again.
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
  });

  test("an occurrence that comes due while the run is parked is skipped, and a manual run is refused", async () => {
    const { routineId } = await setup({ kind: "once", at: Date.now() + 1500 });
    host.approveOnMessage(TOOL, INPUT);
    await startRun(routineId);
    await untilRun(routineId, "waiting");

    const refused = await host.ui("/api/routines/run", { id: routineId });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("waiting for you");

    let skipped: Run | undefined;
    for (let i = 0; i < 160 && !skipped; i++) {
      skipped = (await runs(routineId)).find((r) => r.status === "skipped");
      await Bun.sleep(50);
    }
    expect(skipped?.error).toBe("previous run is waiting for you");
    // The parked run is untouched.
    expect((await runs(routineId)).filter((r) => r.status === "waiting")).toHaveLength(1);
  });

  test("deleting the routine cancels its waits: the card's answer finds nothing", async () => {
    const { botId, other, routineId } = await setup();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);
    await startRun(routineId);
    await untilRun(routineId, "waiting");
    const id = await cardOf(botId, other, page, "approvals");

    expect((await host.ui("/api/routines/delete", { id: routineId })).status).toBe(200);
    expect((await answer(id, "allow")).status).toBe(404);
    // Nothing reached the bot: it never heard of the cancelled request.
    await Bun.sleep(100);
    expect(host.messagesOf(botId)).toHaveLength(1);
  });

  test("deleting the bot cancels its waits and removes the parked run", async () => {
    const { botId, other, routineId } = await setup();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);
    await startRun(routineId);
    await untilRun(routineId, "waiting");
    const id = await cardOf(botId, other, page, "approvals");

    await host.server.removeBot(botId);
    expect((await answer(id, "allow")).status).toBe(404);
    expect((await host.ui("/api/routines/runs", { id: routineId })).status).toBe(404);
  });
});

describe("a parked run and a new session", () => {
  test("starting a new session in the bot's chat fails the parked run and cancels its waits", async () => {
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
    expect((await host.ui("/api/open", { botId })).status).toBe(200);
    const page = await watch();
    const created = await host.ui("/api/routines/create", {
      botId,
      name: "nightly",
      instruction: "mail Ana",
      schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
    });
    const routineId = ((await created.json()) as { id: string }).id;
    host.approveOnMessage(TOOL, INPUT);
    await host.ui("/api/routines/run", { id: routineId });
    await host.until(() => page.approvals().length === 1);
    const card = page.approvals()[0]!;
    const latest = async () =>
      ((await (await host.ui("/api/routines/runs", { id: routineId })).json()) as Run[])[0];
    for (let i = 0; i < 200 && (await latest())?.status !== "waiting"; i++) await Bun.sleep(25);
    expect((await latest())?.status).toBe("waiting");

    expect((await host.ui("/api/session/new", {})).status).toBe(200);
    expect(await latest()).toMatchObject({
      status: "failed",
      error: "session ended while waiting for you",
    });
    expect((await host.ui("/api/answer", { id: card.id, value: "allow" })).status).toBe(404);
  });
});
