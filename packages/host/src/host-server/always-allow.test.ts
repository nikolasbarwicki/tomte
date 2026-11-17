import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "bun";

import { createBot } from "../bots/index.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

const TOOL = "mcp__fx__send_mail";
const INPUT = { to: "ana@example.com", body: "hi" };

/** An integration whose one tool is destructive, which starts out on the `ask` policy. */
let mail: Server<undefined>;
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
  scratch = mkdtempSync(join(tmpdir(), "always-allow-"));
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
type Approval = PageEvent & { id: string; actions?: { id: string; label: string }[] };

/** What a page connected from now on has been shown. */
interface Page {
  approvals(): Approval[];
  answered(): (PageEvent & { id: string })[];
  /** How many turns have ended. */
  done(): number;
}

/** One page's `/api/events` stream from now on. */
async function watch(): Promise<Page> {
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
  const of = (type: string) => seen.filter((e) => e.type === type);
  return {
    approvals: () => of("approve") as Approval[],
    answered: () => of("answered") as (PageEvent & { id: string })[],
    done: () => of("done").length,
  };
}

async function addIntegration() {
  const res = await host.ui("/api/integrations/add-custom", {
    name: "fx",
    url: `http://127.0.0.1:${mail.port}/mcp`,
    transport: "http",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

const answer = (id: string, value: string, note?: string) =>
  host.ui("/api/answer", { id, value, ...(note !== undefined && { note }) });
const allowances = async (botId: string) =>
  (
    (await (await host.ui("/api/bots/allowances", { botId })).json()) as {
      allowances: { tool: string }[];
    }
  ).allowances.map((a) => a.tool);
const last = () => host.permissionResults().at(-1);

/** Sends the open bot a message, which makes the fake CLI ask for a tool; resolves the card it raises, if any, and waits for the turn to end. */
async function turn(page: Page, text: string, resolve: (card: string) => Promise<void>) {
  const before = page.done();
  const cards = page.approvals().length;
  expect((await host.ui("/api/send", { text })).status).toBe(200);
  if (cards === page.approvals().length) {
    await host.until(() => page.approvals().length > cards || page.done() > before);
  }
  const card = page.approvals()[cards];
  if (card) await resolve(card.id);
  await host.until(() => page.done() > before);
}

async function openBot(name = "Planner") {
  const botId = host.createBot(name);
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  return botId;
}

describe("Always allow on an attended approval card", () => {
  test("the card offers Allow, Always allow naming the tool, and Deny", async () => {
    await addIntegration();
    await openBot();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);
    await host.ui("/api/send", { text: "go" });
    await host.until(() => page.approvals().length === 1);
    expect(page.approvals()[0]?.actions).toEqual([
      { id: "allow", label: "Allow" },
      { id: "allow_always", label: `Always allow ${TOOL} for this bot` },
      { id: "deny", label: "Deny" },
    ]);
  });

  test("it allows this call, and the next call to the tool, with any input, has no card", async () => {
    await addIntegration();
    const botId = await openBot();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);

    await turn(page, "first", async (id) => {
      expect((await answer(id, "allow_always")).status).toBe(200);
    });
    expect(host.permissionResults()).toHaveLength(1);
    expect(last()?.response).toMatchObject({ behavior: "allow" });
    expect(page.answered().at(-1)).toMatchObject({ value: "allow_always" });
    expect(await allowances(botId)).toEqual([TOOL]);

    // A rule is for the tool, not the input it was given.
    host.approveOnMessage(TOOL, { to: "someone-else@example.com", body: "other" });
    await turn(page, "second", async () => {});
    expect(host.permissionResults()).toHaveLength(2);
    expect(last()?.response).toMatchObject({ behavior: "allow" });
    expect(page.approvals()).toHaveLength(1);
  });

  test("a plain Allow stores no rule: the same tool with other input asks again", async () => {
    await addIntegration();
    const botId = await openBot();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);
    await turn(page, "first", async (id) => {
      expect((await answer(id, "allow")).status).toBe(200);
    });
    expect(await allowances(botId)).toEqual([]);

    host.approveOnMessage(TOOL, { to: "someone-else@example.com", body: "other" });
    await turn(page, "second", async (id) => {
      expect((await answer(id, "deny")).status).toBe(200);
    });
    expect(page.approvals()).toHaveLength(2);
  });

  test("Deny with a note gives the bot the note", async () => {
    await addIntegration();
    const botId = await openBot();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);
    await turn(page, "go", async (id) => {
      expect((await answer(id, "deny", "send it to the draft folder instead")).status).toBe(200);
    });
    expect(last()?.response).toMatchObject({ behavior: "deny" });
    expect(last()?.response?.message).toContain("user declined");
    expect(last()?.response?.message).toContain("send it to the draft folder instead");
    expect(page.answered().at(-1)).toMatchObject({ value: "deny" });
    expect(await allowances(botId)).toEqual([]);
  });

  test("a rule for one bot does not apply to another", async () => {
    await addIntegration();
    const first = await openBot("First");
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);
    await turn(page, "go", async (id) => {
      await answer(id, "allow_always");
    });
    expect(await allowances(first)).toEqual([TOOL]);

    const second = await openBot("Second");
    expect(await allowances(second)).toEqual([]);
    await turn(page, "go", async (id) => {
      expect((await answer(id, "deny")).status).toBe(200);
    });
    expect(page.approvals()).toHaveLength(2);
    expect(last()?.response).toMatchObject({ behavior: "deny" });
  });

  test("a tool switched off is denied whatever the rule says", async () => {
    const integration = await addIntegration();
    const botId = await openBot();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);
    await turn(page, "first", async (id) => {
      await answer(id, "allow_always");
    });
    expect(await allowances(botId)).toEqual([TOOL]);

    expect(
      (
        await host.ui("/api/integrations/set-policy", {
          id: integration,
          tool: "send_mail",
          policy: "off",
        })
      ).status,
    ).toBe(200);
    await turn(page, "second", async () => {});
    expect(last()?.response).toMatchObject({ behavior: "deny" });
    expect(last()?.response?.message).toContain("switched off");
    expect(page.approvals()).toHaveLength(1);
  });

  test("removing a rule makes the next call ask again", async () => {
    await addIntegration();
    const botId = await openBot();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);
    await turn(page, "first", async (id) => {
      await answer(id, "allow_always");
    });

    expect((await host.ui("/api/bots/allowances/remove", { botId, tool: TOOL })).status).toBe(200);
    expect(await allowances(botId)).toEqual([]);
    expect((await host.ui("/api/bots/allowances/remove", { botId, tool: TOOL })).status).toBe(404);

    await turn(page, "second", async (id) => {
      expect((await answer(id, "deny")).status).toBe(200);
    });
    expect(page.approvals()).toHaveLength(2);
  });

  test("deleting the bot removes its rules", async () => {
    await addIntegration();
    const botId = await openBot();
    const other = await openBot("Other");
    const page = await watch();
    await host.ui("/api/open", { botId });
    host.approveOnMessage(TOOL, INPUT);
    await turn(page, "go", async (id) => {
      await answer(id, "allow_always");
    });
    expect(await allowances(botId)).toEqual([TOOL]);

    await host.ui("/api/open", { botId: other });
    await host.server.removeBot(botId);
    expect((await host.ui("/api/bots/allowances", { botId })).status).toBe(404);
    // A bot that turns up under the same id inherits nothing.
    createBot(host.dataRoot, "Again", "", botId);
    expect(await allowances(botId)).toEqual([]);
  });

  test("an allowance route for an unknown bot is refused", async () => {
    expect((await host.ui("/api/bots/allowances", { botId: "nobody" })).status).toBe(404);
    expect(
      (await host.ui("/api/bots/allowances/remove", { botId: "nobody", tool: TOOL })).status,
    ).toBe(404);
  });
});

describe.each([
  ["chat-hosted", true],
  ["headless", false],
])("Always allow and a %s routine run", (_label, chatHosted) => {
  type Run = { id: string; status: string };
  async function setup() {
    await addIntegration();
    const botId = host.createBot("Planner");
    const other = host.createBot("Other");
    const created = await host.ui("/api/routines/create", {
      botId,
      name: "nightly",
      instruction: "mail Ana",
      schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
    });
    const routineId = ((await created.json()) as { id: string }).id;
    await host.ui("/api/open", { botId: chatHosted ? botId : other });
    return { botId, other, routineId };
  }
  const runs = async (routineId: string) =>
    (await (await host.ui("/api/routines/runs", { id: routineId })).json()) as Run[];
  const untilRun = async (routineId: string, count: number, status: string) => {
    for (let i = 0; i < 200; i++) {
      const all = await runs(routineId);
      if (all.length >= count && all[0]?.status === status) return;
      await Bun.sleep(25);
    }
    expect((await runs(routineId))[0]?.status).toBe(status);
  };

  test("Always allow on a parked approval resumes the run, and the next run never parks on the tool", async () => {
    const { botId, other, routineId } = await setup();
    const page = await watch();
    host.approveOnMessage(TOOL, INPUT);
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await untilRun(routineId, 1, "waiting");

    if (!chatHosted) await host.ui("/api/open", { botId });
    await host.until(() => page.approvals().length === 1);
    const id = page.approvals()[0]!.id;
    expect(page.approvals()[0]?.actions?.map((a) => a.id)).toEqual([
      "allow",
      "allow_always",
      "deny",
    ]);
    if (!chatHosted) await host.ui("/api/open", { botId: other });
    expect((await answer(id, "allow_always")).status).toBe(200);
    await untilRun(routineId, 1, "succeeded");
    expect(await allowances(botId)).toEqual([TOOL]);

    // The next run asks for the tool with other input and goes straight through.
    host.approveOnMessage(TOOL, { to: "bo@example.com", body: "again" });
    const before = host.permissionResults().length;
    expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await untilRun(routineId, 2, "succeeded");
    await host.until(() => host.permissionResults().length > before);
    expect(last()?.response).toMatchObject({ behavior: "allow" });
    expect((await runs(routineId)).map((r) => r.status)).not.toContain("waiting");
    expect(page.approvals()).toHaveLength(1);
  });
});
