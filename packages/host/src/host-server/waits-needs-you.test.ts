import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

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
  scratch = mkdtempSync(join(tmpdir(), "waits-needs-you-"));
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

type PageEvent = { type: string; [k: string]: unknown };
type BotRow = { id: string; needsYou: number; needsYouSources: string[]; needsYouAt: number };

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
  return {
    /** What the sidebar shows for a bot now; undefined before the first bots slice. */
    bot(botId: string): BotRow | undefined {
      const latest = seen.filter((e) => e.type === "bots").at(-1) as { bots: BotRow[] } | undefined;
      return latest?.bots.find((b) => b.id === botId);
    },
    approvals: () => seen.filter((e) => e.type === "approve") as (PageEvent & { id: string })[],
  };
}

async function addMail() {
  expect(
    (
      await host.ui("/api/integrations/add-custom", {
        name: "fx",
        url: `http://127.0.0.1:${mail.port}/mcp`,
        transport: "http",
      })
    ).status,
  ).toBe(200);
}

/** A routine on a bot that is not open, parked on an approval. */
async function parkedRoutine() {
  await addMail();
  const botId = host.createBot("Planner");
  const other = host.createBot("Other");
  expect((await host.ui("/api/open", { botId: other })).status).toBe(200);
  const created = await host.ui("/api/routines/create", {
    botId,
    name: "nightly",
    instruction: "mail Ana",
    schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
  });
  const routineId = ((await created.json()) as { id: string }).id;
  host.approveOnMessage(TOOL, INPUT);
  expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
  return { botId, other, routineId };
}

test("a routine parked on a bot that is not open raises that bot's count under the routine's name, and answering lowers it", async () => {
  const { botId, other } = await parkedRoutine();
  const page = await watch();

  await host.until(() => page.bot(botId)?.needsYou === 1);
  expect(page.bot(botId)?.needsYouSources).toEqual(["nightly"]);
  expect(page.bot(botId)?.needsYouAt).toBeGreaterThan(0);
  expect(page.bot(other)?.needsYou).toBe(0);

  // The card is replayed when the owner opens the bot; the bar's count does not wait for that.
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  await host.until(() => page.approvals().length > 0);
  const card = page.approvals().at(-1)!;
  expect(page.bot(botId)?.needsYou).toBe(1);

  expect((await host.ui("/api/answer", { id: card.id, value: "allow" })).status).toBe(200);
  await host.until(() => page.bot(botId)?.needsYou === 0);
  expect(page.bot(botId)).toMatchObject({ needsYouSources: [], needsYouAt: 0 });
});

test("an expired park lowers the count", async () => {
  const { botId } = await parkedRoutine();
  const before = await watch();
  await host.until(() => before.bot(botId)?.needsYou === 1);

  host.stopApproving();
  host.advanceClock(DAY + 1000);
  await host.restart();

  const after = await watch();
  await host.until(() => after.bot(botId) !== undefined);
  expect(after.bot(botId)?.needsYou).toBe(0);
});

test("a wait of a bot's own chat counts under what it asks for and a page that connects later is told", async () => {
  await addMail();
  const botId = host.createBot("Planner");
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  host.approveOnMessage(TOOL, INPUT);
  const first = await watch();

  await host.ui("/api/send", { text: "mail her" });
  await host.until(() => first.approvals().length === 1);
  await host.until(() => first.bot(botId)?.needsYou === 1);
  expect(first.bot(botId)?.needsYouSources).toEqual(["Approval"]);

  const later = await watch();
  await host.until(() => later.bot(botId) !== undefined);
  expect(later.bot(botId)?.needsYou).toBe(1);

  const card = first.approvals()[0]!;
  expect((await host.ui("/api/answer", { id: card.id, value: "deny" })).status).toBe(200);
  await host.until(() => first.bot(botId)?.needsYou === 0);
  await host.until(() => later.bot(botId)?.needsYou === 0);
});
