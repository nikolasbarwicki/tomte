import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// `create_bot`, the one bots tool that always asks, on a whole host: the fake CLI asks the host's permission for the
// tool and, only when it is allowed, calls it on the bots server of its own MCP config, as the real CLI does.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ChannelLinkCodeResponse } from "@tomte/contract/api";

import { botMemoryPath, listBots, readMemory, setChatMode } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { fakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { WEEKDAYS } from "../testing/routines-kit.ts";
import { parse, startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

const TOOL = "mcp__bots__create_bot";
const SEED = "The owner is VAT-registered and wants invoices in PLN.";
const ARGS = { name: "Invoices", purpose: "Tracks the owner's invoices", memory: SEED };
const UNATTENDED = "scheduled runs cannot create bots; ask the user in chat";
const owner = { id: 4242, first_name: "Owner", last_name: "One" };

let host: HandoffHost;
let page: EventsWatch;
let tg: FakeTelegram | undefined;
beforeEach(async () => {
  host = await startHandoffHost();
  page = await watchEvents(host);
});
afterEach(async () => {
  page.stop();
  await host.stop();
  await tg?.stop();
  tg = undefined;
});

/** A bot with its chat open. */
async function chief(mode: "standard" | "double_loop" = "standard", name = "Chief") {
  const id = host.createBot(name, "Routes work");
  if (mode === "double_loop") setChatMode(host.dataRoot, id, "double_loop");
  expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
  return id;
}

/** The scripted CLI asks for `create_bot` on the next message that holds `match`. */
const createOn = (match: string, args: Record<string, unknown> = ARGS) =>
  host.loopScript({ match, steps: [{ httpTool: { server: "bots", tool: "create_bot", args } }] });

type Approval = { id: string; tool: string; input: string; actions: { id: string }[] };
const approvals = () => page.events().filter((e) => e.type === "approve") as unknown as Approval[];
const created = () => listBots(host.dataRoot).filter((b) => b.name === ARGS.name);
const send = async (text: string) =>
  expect((await host.ui("/api/send", { text })).status).toBe(200);
const answer = (id: string, value: string) => host.ui("/api/answer", { id, value });

async function approvalCard(n = 0) {
  await host.until(() => approvals().length > n);
  return defined(approvals()[n], "approval card");
}

describe("create_bot in a standard chat", () => {
  test("raises a card with the exact arguments and no always allow; approving creates the bot with its seed and the browser off", async () => {
    const id = await chief();
    createOn("make me an invoice bot");
    await send("make me an invoice bot");

    const card = await approvalCard();
    expect(card.tool).toBe(TOOL);
    expect(JSON.parse(card.input)).toEqual(ARGS);
    expect(card.actions.map((a) => a.id)).toEqual(["allow", "deny"]);
    expect(created()).toEqual([]);

    expect((await answer(card.id, "allow")).status).toBe(200);
    await host.until(() => host.loopCalls().length === 1);
    await host.until(() => !host.server.isWorking(id));

    const [bot] = created();
    expect(bot).toMatchObject({
      name: "Invoices",
      purpose: "Tracks the owner's invoices",
      chatMode: "standard",
      browser: { enabled: false },
    });
    expect(readMemory(botMemoryPath(host.dataRoot, defined(bot, "bot").id))).toBe(`${SEED}\n`);
    const result = parse<{ bot_id: string; name: string; chat_mode: string }>({
      isError: false,
      text: host.toolResults()[0]!,
    });
    expect(result).toMatchObject({ bot_id: bot!.id, name: "Invoices", chat_mode: "standard" });
    await host.until(() =>
      page
        .events()
        .some(
          (e) =>
            e.type === "bots" &&
            Object.values(e.bots as Record<string, { name: string }>).some(
              (b) => b.name === "Invoices",
            ),
        ),
    );
  });

  test("chat_mode double_loop starts the new bot in that mode", async () => {
    await chief();
    createOn("make a coordinator", { ...ARGS, chat_mode: "double_loop" });
    await send("make a coordinator");
    expect((await answer((await approvalCard()).id, "allow")).status).toBe(200);
    await host.until(() => created().length === 1);
    expect(created()[0]?.chatMode).toBe("double_loop");
  });

  test("denying creates nothing and the CLI makes no call", async () => {
    const id = await chief();
    createOn("make me an invoice bot");
    await send("make me an invoice bot");
    expect((await answer((await approvalCard()).id, "deny")).status).toBe(200);
    await host.until(() => !host.server.isWorking(id));

    expect(host.permissionResults().at(-1)?.response?.behavior).toBe("deny");
    expect(host.loopCalls()).toEqual([]);
    expect(created()).toEqual([]);
  });

  test("an always-allow answer is refused, and the next call asks again", async () => {
    const id = await chief();
    host.loopScript(
      { match: "first", steps: [{ httpTool: { server: "bots", tool: "create_bot", args: ARGS } }] },
      {
        match: "second",
        steps: [
          {
            httpTool: { server: "bots", tool: "create_bot", args: { ...ARGS, name: "Invoices 2" } },
          },
        ],
      },
    );
    await send("first");
    const first = await approvalCard();
    expect((await answer(first.id, "allow_always")).status).toBe(404);
    expect((await answer(first.id, "allow")).status).toBe(200);
    await host.until(() => host.loopCalls().length === 1);
    await host.until(() => !host.server.isWorking(id));
    expect(
      (
        (await (await host.ui("/api/bots/allowances", { botId: id })).json()) as {
          allowances: unknown[];
        }
      ).allowances,
    ).toEqual([]);

    await send("second");
    const second = await approvalCard(1);
    expect(second.id).not.toBe(first.id);
    expect(second.actions.map((a) => a.id)).toEqual(["allow", "deny"]);
  });

  test("the 20-bot cap holds: at 20 bots the call is refused with a plain reason and nothing is created", async () => {
    const id = await chief();
    for (let i = 0; i < 19; i++) host.createBot(`Bot ${i}`);
    expect(listBots(host.dataRoot)).toHaveLength(20);
    createOn("one more");
    await send("one more");
    expect((await answer((await approvalCard()).id, "allow")).status).toBe(200);
    await host.until(() => host.loopCalls().length === 1);
    await host.until(() => !host.server.isWorking(id));

    expect(host.loopCalls()[0]?.result?.isError).toBe(true);
    expect(host.toolResults()[0]).toContain("20 bots");
    expect(listBots(host.dataRoot)).toHaveLength(20);
  });

  test.each([
    ["an empty name", { ...ARGS, name: "  " }, "name is empty"],
    ["an empty purpose", { ...ARGS, purpose: "" }, "purpose is empty"],
    ["a long name", { ...ARGS, name: "n".repeat(81) }, "name is 81"],
    ["a long purpose", { ...ARGS, purpose: "p".repeat(401) }, "purpose is 401"],
    ["a long seed", { ...ARGS, memory: "m".repeat(1201) }, "memory seed is 1201"],
  ])("%s is refused with its reason and creates nothing", async (_label, args, reason) => {
    await chief();
    const caller = await host.actAs(listBots(host.dataRoot)[0]!.id);
    const result = await caller.call("create_bot", args);
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain(reason);
    expect(created()).toEqual([]);
  });
});

describe("create_bot reaches every session kind", () => {
  test("a double-loop front asks and creates after approval", async () => {
    const id = await chief("double_loop");
    createOn("make me an invoice bot");
    await send("make me an invoice bot");
    const card = await approvalCard();
    expect(card.actions.map((a) => a.id)).toEqual(["allow", "deny"]);
    expect((await answer(card.id, "allow")).status).toBe(200);
    await host.until(() => created().length === 1);
    await host.until(() => !host.server.isWorking(id));
    expect(readMemory(botMemoryPath(host.dataRoot, created()[0]!.id))).toBe(`${SEED}\n`);
  });

  describe.each([
    ["chat-hosted", true],
    ["headless", false],
  ])("a %s routine run", (_label, openChat) => {
    const routine = {
      name: "Weekly review",
      instruction: "Review the week and set up whatever bots are missing.",
      schedule: WEEKDAYS,
    };

    /** The bot's routine runs once; `script` is what the fake CLI does when the run's message arrives. */
    async function run(script: Record<string, unknown>[]) {
      const id = host.createBot("Chief", "Routes work");
      const res = await host.ui("/api/routines/create", { botId: id, ...routine });
      expect(res.status).toBe(200);
      const routineId = ((await res.json()) as { id: string }).id;
      if (openChat) expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
      host.loopScript({ match: routine.instruction, steps: script });
      expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
      await host.until(() => host.messagesOf(id).length > 0);
      await host.until(() => !host.server.isWorking(id));
      return id;
    }

    test("the permission check refuses before any card, so no approval is parked and nothing is created", async () => {
      const id = await run([{ httpTool: { server: "bots", tool: "create_bot", args: ARGS } }]);

      const answered = host.permissionResults().at(-1);
      expect(answered).toMatchObject({
        tool_name: TOOL,
        response: { behavior: "deny", message: UNATTENDED },
      });
      expect(host.loopCalls()).toEqual([]);
      expect(approvals()).toEqual([]);
      expect(created()).toEqual([]);
      expect(page.needsYou(id) ?? 0).toBe(0);
    });

    test("the tool itself refuses when it is called without the permission check", async () => {
      const id = host.createBot("Chief", "Routes work");
      const res = await host.ui("/api/routines/create", { botId: id, ...routine });
      const routineId = ((await res.json()) as { id: string }).id;
      if (openChat) expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
      host.callOnMessage("bots", "create_bot", ARGS);
      expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
      await host.until(() => host.toolResults().length === 1);
      await host.until(() => !host.server.isWorking(id));

      expect(host.toolResults()).toEqual([UNATTENDED]);
      expect(host.loopCalls()[0]?.result?.isError).toBe(true);
      expect(created()).toEqual([]);
    });
  });
});

describe("who has create_bot", () => {
  async function toolsOf(botId: string) {
    const { token, url } = await host.actAs(botId);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    try {
      return (await client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  }

  test("every bot lists it, whatever the others are", async () => {
    const ada = host.createBot("Ada", "Writes");
    const grace = host.createBot("Grace", "Reads");
    expect(await toolsOf(ada)).toContain("create_bot");
    expect(await toolsOf(grace)).toContain("create_bot");
  });

  test("it can only create: no tool edits or deletes a bot, or changes another bot's setup", async () => {
    await chief();
    const names = await toolsOf(listBots(host.dataRoot)[0]!.id);
    expect(names.sort()).toEqual(
      [
        "cancel_handoff",
        "complete_handoff",
        "create_bot",
        "fail_handoff",
        "hand_off",
        "handoff_message",
        "list_bots",
        "list_handoffs",
      ].sort(),
    );
  });
});

describe("the approval card on the phone", () => {
  test("reaches the fake Bot API with the exact arguments and no always allow; Allow creates the bot, and the card is edited", async () => {
    tg = fakeTelegram();
    await host.stop();
    host = await startHandoffHost([], undefined, undefined, {
      telegram: { baseUrl: tg.url, pollTimeoutSeconds: 30, sendSpacingMs: 10, backoffMs: 20 },
      cards: { retryMs: 30 },
    });
    page.stop();
    page = await watchEvents(host);
    const handled = (id: number) =>
      host.until(() =>
        tg!
          .of("getUpdates")
          .some((c) => typeof c.params.offset === "number" && c.params.offset > id),
      );
    expect((await host.ui("/api/channels/telegram/token", { token: tg.token })).status).toBe(200);
    await host.until(() => tg!.of("getUpdates").length > 0);
    const code = ChannelLinkCodeResponse.parse(
      await (await host.ui("/api/channels/link-code", { channel: "telegram" })).json(),
    ).code;
    await handled(tg.message(owner, code));

    const id = await chief();
    createOn("make me an invoice bot");
    await send("make me an invoice bot");

    const cards = () =>
      tg!
        .of("sendMessage")
        .filter((c) => c.status === 200 && !String(c.params.text).startsWith("Linked."));
    await host.until(() => cards().length === 1);
    const card = defined(cards()[0], "card");
    const text = String(card.params.text);
    expect(text).toContain(TOOL);
    expect(text).toContain("Invoices");
    expect(text).toContain("Tracks the owner's invoices");
    expect(text).toContain(SEED);
    type Keyboard = { text: string; callback_data?: string }[][];
    const keyboard = (card.params.reply_markup as { inline_keyboard: Keyboard }).inline_keyboard;
    const buttons = keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(["Allow", "Deny"]);
    expect(created()).toEqual([]);

    const before = tg.of("answerCallbackQuery").length;
    await handled(
      tg.press(owner, defined(buttons[0]?.callback_data, "Allow data"), card.messageId!),
    );
    await host.until(() => tg!.of("answerCallbackQuery").length > before);
    await host.until(() => created().length === 1);
    await host.until(() => !host.server.isWorking(id));
    expect(readMemory(botMemoryPath(host.dataRoot, created()[0]!.id))).toBe(`${SEED}\n`);
    await host.until(() =>
      tg!.of("editMessageText").some((e) => e.params.message_id === card.messageId),
    );
  });
});
