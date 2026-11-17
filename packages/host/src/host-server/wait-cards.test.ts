import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ChannelLinkCodeResponse, type EventAccess } from "@tomte/contract/api";

import { defined } from "../testing/defined.ts";
import { fakeTelegram, type FakeCall, type FakeTelegram } from "../testing/fake-telegram.ts";
import { parse, startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

const DAY = 24 * 60 * 60_000;
const TOOL = "mcp__fx__send_mail";
const INPUT = { to: "ana@example.com", body: "hi" };
const owner = { id: 4242, first_name: "Owner", last_name: "One" };
const TOO_LONG = "Input too long to show here. Open the web UI to approve.";

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

const hosts: HandoffHost[] = [];
const fakes: FakeTelegram[] = [];
const watches: EventsWatch[] = [];
const clients: Client[] = [];
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "wait-cards-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
});
afterEach(async () => {
  for (const w of watches.splice(0)) w.stop();
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const h of hosts.splice(0)) await h.stop();
  for (const f of fakes.splice(0)) await f.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

type Keyboard = { text: string; callback_data?: string; url?: string }[][];
type Run = { id: string; status: string; error: string | null; output: string | null };

/** A host with a fake Telegram Bot API, the ask-policy integration and helpers to read the cards it sent and act on them as the owner. */
async function start(hostFlags: string[] = []) {
  const tg = fakeTelegram();
  fakes.push(tg);
  const host = await startHandoffHost(hostFlags, undefined, undefined, {
    telegram: { baseUrl: tg.url, pollTimeoutSeconds: 30, sendSpacingMs: 10, backoffMs: 20 },
    cards: { retryMs: 30 },
  });
  hosts.push(host);
  const page = await watchEvents(host);
  watches.push(page);

  /** Waits until the adapter has confirmed the update, so what it did about it is done. */
  const handled = (id: number) =>
    host.until(() =>
      tg.of("getUpdates").some((c) => typeof c.params.offset === "number" && c.params.offset > id),
    );
  const link = async () => {
    expect((await host.ui("/api/channels/telegram/token", { token: tg.token })).status).toBe(200);
    await host.until(() => tg.of("getUpdates").length > 0);
    const res = await host.ui("/api/channels/link-code", { channel: "telegram" });
    const { code } = ChannelLinkCodeResponse.parse(await res.json());
    await handled(tg.message(owner, code));
  };
  const addMail = async () =>
    expect(
      (
        await host.ui("/api/integrations/add-custom", {
          name: "fx",
          url: `http://127.0.0.1:${mail.port}/mcp`,
          transport: "http",
        })
      ).status,
    ).toBe(200);

  /** The messages the host sent that are cards: everything but the link confirmation. A question with no options has no keyboard. */
  const cards = () =>
    tg
      .of("sendMessage")
      .filter((c) => c.status === 200 && !String(c.params.text).startsWith("Linked."));
  const keyboard = (c: FakeCall): Keyboard =>
    (c.params.reply_markup as { inline_keyboard: Keyboard } | undefined)?.inline_keyboard ?? [];
  const labels = (c: FakeCall) =>
    keyboard(c)
      .flat()
      .filter((b) => b.callback_data !== undefined)
      .map((b) => b.text);
  const dataOf = (c: FakeCall, label: string) =>
    defined(
      keyboard(c)
        .flat()
        .find((b) => b.text === label),
      `button ${label}`,
    ).callback_data!;
  const text = (c: FakeCall) => String(c.params.text);
  /** The nth card sent, once it is there. */
  const card = async (n: number) => {
    await host.until(() => cards().length > n);
    return defined(cards()[n], "card");
  };
  /** The id of the wait a card is for, read from its buttons' data. */
  const waitId = (c: FakeCall) => {
    const data = keyboard(c)
      .flat()
      .find((b) => b.callback_data?.startsWith("w:"))?.callback_data;
    return defined(data, "wait button").split(":")[1]!;
  };
  const edits = (c: FakeCall) =>
    tg.of("editMessageText").filter((e) => e.params.message_id === c.messageId);
  /** The latest edit of a card, once there is one. */
  const edited = async (c: FakeCall) => {
    await host.until(() => edits(c).length > 0);
    return text(defined(edits(c).at(-1), "edit"));
  };
  const toast = () => String(tg.of("answerCallbackQuery").at(-1)?.params.text);
  const pressData = async (c: FakeCall, data: string) => {
    const before = tg.of("answerCallbackQuery").length;
    await handled(tg.press(owner, data, c.messageId!));
    await host.until(() => tg.of("answerCallbackQuery").length > before);
    return toast();
  };
  const press = (c: FakeCall, label: string) => pressData(c, dataOf(c, label));
  const say = (words: string, replyTo?: FakeCall) =>
    handled(tg.message(owner, words, replyTo ? { replyTo: replyTo.messageId! } : {}));
  const links = (c: FakeCall) =>
    keyboard(c)
      .flat()
      .filter((b) => b.url !== undefined);

  const openBot = async (name = "Planner") => {
    const botId = host.createBot(name);
    expect((await host.ui("/api/open", { botId })).status).toBe(200);
    return botId;
  };

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

  return {
    tg,
    host,
    page,
    link,
    addMail,
    cards,
    card,
    keyboard,
    labels,
    dataOf,
    text,
    waitId,
    edits,
    edited,
    toast,
    press,
    pressData,
    say,
    links,
    openBot,
    browserAs,
  };
}

type Started = Awaited<ReturnType<typeof start>>;

describe("an approval card", () => {
  async function asking(t: Started, input: Record<string, unknown> = INPUT) {
    await t.link();
    await t.addMail();
    const botId = await t.openBot();
    t.host.approveOnMessage(TOOL, input);
    await t.host.ui("/api/send", { text: "mail her" });
    return botId;
  }

  test("shows the tool, the reason and the exact input, with buttons that are indexes; Allow reaches the tool and the card is edited", async () => {
    const t = await start();
    await asking(t);
    const c = await t.card(0);

    const body = t.text(c);
    expect(body).toContain(`Allow ${TOOL}?`);
    expect(body).toContain("Reason: ");
    expect(body).toContain(JSON.stringify(INPUT, null, 2));
    expect(t.labels(c)).toEqual(["Allow", `Always allow ${TOOL} for this bot`, "Deny"]);
    const id = t.waitId(c);
    expect(
      t
        .keyboard(c)
        .flat()
        .map((b) => b.callback_data),
    ).toEqual([`w:${id}:0`, `w:${id}:1`, `w:${id}:2`]);
    expect(t.host.permissionResults()).toEqual([]);

    expect(await t.press(c, "Allow")).toBe("Answered");
    await t.host.until(() => t.host.permissionResults().length === 1);
    expect(t.host.permissionResults()[0]).toMatchObject({
      tool_name: TOOL,
      response: { behavior: "allow" },
    });
    expect(await t.edited(c)).toEndWith("Answered: Allow");
    const last = defined(t.edits(c).at(-1), "edit");
    expect(JSON.stringify(last.params.reply_markup ?? {})).not.toContain("callback_data");
    expect(t.cards()).toHaveLength(1);
  });

  test("always allow stores the rule for the tool", async () => {
    const t = await start();
    await asking(t);
    const c = await t.card(0);
    expect(await t.press(c, `Always allow ${TOOL} for this bot`)).toBe("Answered");
    await t.host.until(() => t.host.permissionResults().length === 1);
    expect(await t.edited(c)).toEndWith(`Answered: Always allow ${TOOL} for this bot`);
    // The rule covers later calls with any input: no card is asked.
    t.host.approveOnMessage(TOOL, { to: "bob@example.com", body: "other" });
    await t.host.ui("/api/send", { text: "again" });
    await t.host.until(() => t.host.permissionResults().length === 2);
    expect(t.host.permissionResults()[1]).toMatchObject({ response: { behavior: "allow" } });
    expect(t.cards()).toHaveLength(1);
  });

  test("a reply denies it, and the text is the note the bot receives", async () => {
    const t = await start();
    await asking(t);
    const c = await t.card(0);
    await t.say("not tonight", c);
    await t.host.until(() => t.host.permissionResults().length === 1);
    expect(t.host.permissionResults()[0]).toMatchObject({
      response: { behavior: "deny", message: "user declined: not tonight" },
    });
    expect(await t.edited(c)).toEndWith("Answered: Deny");
  });

  test("a plain message answers it when it is the only open card", async () => {
    const t = await start();
    await asking(t);
    await t.card(0);
    await t.say("wrong recipient");
    await t.host.until(() => t.host.permissionResults().length === 1);
    expect(t.host.permissionResults()[0]?.response?.message).toBe("user declined: wrong recipient");
  });

  test("is cut when the input is too long: only Deny is offered, and an Allow callback for it is refused", async () => {
    const t = await start();
    await asking(t, { to: "ana@example.com", body: "x".repeat(6000) });
    const c = await t.card(0);

    const body = t.text(c);
    expect(body).toContain("…");
    expect(body).toContain(TOO_LONG);
    expect(body.length).toBeLessThan(3100);
    expect(body).not.toContain("x".repeat(3000));
    expect(t.labels(c)).toEqual(["Deny"]);
    const id = t.waitId(c);
    // The first stored action is Allow, which this card never offered.
    expect(await t.pressData(c, `w:${id}:0`)).toBe(TOO_LONG);
    expect(await t.pressData(c, `w:${id}:1`)).toBe(TOO_LONG);
    expect(t.host.permissionResults()).toEqual([]);
    expect(t.edits(c)).toEqual([]);

    expect(await t.press(c, "Deny")).toBe("Answered");
    await t.host.until(() => t.host.permissionResults().length === 1);
    expect(t.host.permissionResults()[0]).toMatchObject({ response: { behavior: "deny" } });
  });

  test("answered on the web: the card is edited, and a press after it is refused as handled", async () => {
    const t = await start();
    await asking(t);
    const c = await t.card(0);
    const id = t.waitId(c);
    const data = t.dataOf(c, "Allow");

    expect((await t.host.ui("/api/answer", { id, value: "deny" })).status).toBe(200);
    expect(await t.edited(c)).toEndWith("Answered: Deny");
    expect(await t.pressData(c, data)).toBe("already handled");
    expect(t.host.permissionResults()).toHaveLength(1);
  });

  test("two presses answer once", async () => {
    const t = await start();
    await asking(t);
    const c = await t.card(0);
    const allow = t.dataOf(c, "Allow");
    const before = t.tg.of("answerCallbackQuery").length;
    const a = t.tg.press(owner, allow, c.messageId!);
    const b = t.tg.press(owner, allow, c.messageId!);
    await t.host.until(() => t.tg.of("answerCallbackQuery").length >= before + 2);
    expect(a).toBeLessThan(b);
    expect(
      t.tg
        .of("answerCallbackQuery")
        .slice(before)
        .map((x) => x.params.text),
    ).toEqual(["Answered", "already handled"]);
    await t.host.until(() => t.host.permissionResults().length === 1);
    await Bun.sleep(100);
    expect(t.host.permissionResults()).toHaveLength(1);
  });
});

describe("a question card", () => {
  test("shows its options as buttons; a button answers it and the bot gets the option", async () => {
    const t = await start();
    await t.link();
    const botId = await t.openBot();
    t.host.askOnMessage("Which database?", ["Postgres", "SQLite"]);
    await t.host.ui("/api/send", { text: "hi" });
    const c = await t.card(0);

    expect(t.text(c)).toStartWith("Planner asks: Which database?");
    expect(t.labels(c)).toEqual(["Postgres", "SQLite"]);
    expect(t.text(c)).toContain("Reply to this message to answer.");
    const id = t.waitId(c);
    expect(t.dataOf(c, "SQLite")).toBe(`w:${id}:1`);

    t.host.stopAsking();
    expect(await t.press(c, "SQLite")).toBe("Answered");
    await t.host.until(() => t.host.toolResults().some((r) => r.includes("SQLite")));
    expect(await t.edited(c)).toEndWith("Answered: SQLite");
    expect(t.host.messagesOf(botId)).toEqual(["hi"]);
  });

  test("a reply answers it in words", async () => {
    const t = await start();
    await t.link();
    await t.openBot();
    t.host.askOnMessage("Name?");
    await t.host.ui("/api/send", { text: "hi" });
    const c = await t.card(0);
    expect(t.labels(c)).toEqual([]);
    t.host.stopAsking();
    await t.say("Ada", c);
    await t.host.until(() => t.host.toolResults().some((r) => r.includes("Ada")));
    expect(await t.edited(c)).toEndWith("Answered: Ada");
  });

  test("one about an external event has no card of its own: the event's card answers it", async () => {
    const t = await start();
    await t.link();
    const botId = await t.openBot();
    t.host.askOnMessage("Which database?", ["Postgres", "SQLite"], { delivered: true });
    const { token } = (await (
      await t.host.ui("/api/bots/events-token", { botId })
    ).json()) as EventAccess;
    const res = await fetch(`${t.host.clientUrl}/api/bots/${botId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: "question",
        key: "k1",
        source: { id: "auth-sso", label: "auth-sso" },
        title: "Which database?",
        options: ["Postgres", "SQLite"],
      }),
    });
    expect(res.status).toBe(202);
    const c = await t.card(0);
    await t.host.until(() => t.host.db.query("SELECT 1 FROM human_waits").get() !== null);
    await Bun.sleep(200);
    expect(t.cards()).toHaveLength(1);
    expect(t.text(c)).toStartWith("auth-sso · Which database?");
    expect(
      t.host.db.query("SELECT item_kind FROM channel_cards").all() as { item_kind: string }[],
    ).toEqual([{ item_kind: "event" }]);

    t.host.stopAsking();
    expect(await t.press(c, "SQLite")).toBe("Answered");
    await t.host.until(() => t.host.toolResults().some((r) => r.includes("SQLite")));
  });
});

describe("a takeover card", () => {
  test("shows the reason, the link to the browser panel and I'm done and Skip; words are refused; Skip tells the bot", async () => {
    const t = await start(["--public-url", "https://tomte.example.com"]);
    await t.link();
    const botId = await t.openBot();
    const call = await t.browserAs(botId);
    const wait = parse<{ id: string }>(
      await call("browser_request_takeover", { reason: "solve the CAPTCHA" }),
    );
    const c = await t.card(0);

    expect(t.text(c)).toContain("Planner needs you: solve the CAPTCHA");
    expect(t.labels(c)).toEqual(["I'm done", "Skip"]);
    expect(t.links(c)).toEqual([
      {
        text: "Open in Tomte",
        url: `https://tomte.example.com/bots/${botId}?panel=browser`,
      },
    ]);
    expect(t.waitId(c)).toBe(wait.id);

    await t.say("I solved it", c);
    await t.host.until(() => t.tg.texts().includes("use the buttons"));
    expect(t.host.db.query("SELECT state FROM human_waits WHERE id = ?").get(wait.id)).toEqual({
      state: "open",
    });

    expect(await t.press(c, "Skip")).toBe("Answered");
    expect(await t.edited(c)).toEndWith("Answered: Skip");
    await t.host.until(() => t.host.messagesOf(botId).some((m) => m.includes("skipped")));
  });

  test("is sent for a wait on a bot that is busy, and answering it reaches the bot when its turn ends", async () => {
    const t = await start();
    await t.link();
    const botId = await t.openBot();
    t.host.hold();
    await t.host.ui("/api/send", { text: "work" });
    await t.host.until(() => t.host.messagesOf(botId).length === 1);
    const call = await t.browserAs(botId);
    await call("browser_request_takeover", { reason: "log in by hand" });
    const c = await t.card(0);

    expect(await t.press(c, "I'm done")).toBe("Answered");
    expect(await t.edited(c)).toEndWith("Answered: I'm done");
    t.host.release();
    await t.host.until(() => t.host.messagesOf(botId).some((m) => m.includes("finished")));
  });

  test("a takeover the restart cancelled has its card edited to Cancelled", async () => {
    const t = await start();
    await t.link();
    const botId = await t.openBot();
    const call = await t.browserAs(botId);
    await call("browser_request_takeover", { reason: "solve the CAPTCHA" });
    const c = await t.card(0);

    await t.host.restart();
    expect(await t.edited(c)).toEndWith("Cancelled");
    expect(
      JSON.stringify(defined(t.edits(c).at(-1), "edit").params.reply_markup ?? {}),
    ).not.toContain("callback_data");
  });
});

describe("a sign-in approval card", () => {
  test("shows its title and detail with Allow and Deny, and Allow creates the grant", async () => {
    const t = await start();
    await t.link();
    const botId = await t.openBot();
    expect(
      (
        await t.host.ui("/api/credentials/add", {
          label: "GH",
          signInUrl: "http://localhost:3999/login",
          username: "me",
          password: "pw-pw-pw-pw",
        })
      ).status,
    ).toBe(200);
    const call = await t.browserAs(botId);
    await call("browser_login", { entry: "GH" });
    const c = await t.card(0);

    expect(t.text(c)).toContain('Planner · Allow sign-in with "GH"?');
    expect(t.text(c)).toContain("It never sees the password.");
    expect(t.labels(c)).toEqual(["Allow", "Deny"]);
    await t.say("sure", c);
    await t.host.until(() => t.tg.texts().includes("use the buttons"));

    expect(await t.press(c, "Allow")).toBe("Answered");
    expect(await t.edited(c)).toEndWith("Answered: Allow");
    await t.host.until(() =>
      t.host.messagesOf(botId).some((m) => m.includes('Call browser_login("GH") again')),
    );
  });
});

describe("which waits get a card", () => {
  test("one that is open when the account links is sent; one already closed never is", async () => {
    const t = await start();
    await t.addMail();
    const botId = await t.openBot();
    const call = await t.browserAs(botId);
    const closed = parse<{ id: string }>(await call("browser_request_takeover", { reason: "A" }));
    expect((await t.host.ui("/api/waits/answer", { id: closed.id, action: "skip" })).status).toBe(
      200,
    );
    await t.host.until(() => t.host.messagesOf(botId).length >= 1);
    t.host.approveOnMessage(TOOL, INPUT);
    await t.host.ui("/api/send", { text: "mail her" });
    await t.host.until(() => t.page.events().some((e) => e.type === "approve"));
    expect(t.tg.outgoing()).toEqual([]);

    await t.link();
    const c = await t.card(0);
    expect(t.text(c)).toContain(`Allow ${TOOL}?`);
    await Bun.sleep(200);
    expect(t.cards()).toHaveLength(1);
  });

  test("one that opened while Telegram refused the bot is sent once it works, and a restart sends nothing twice", async () => {
    const t = await start();
    await t.link();
    await t.addMail();
    await t.openBot();
    t.tg.revoke();
    t.host.approveOnMessage(TOOL, INPUT);
    await t.host.ui("/api/send", { text: "mail her" });
    await t.host.until(() => t.tg.of("sendMessage").some((c) => !c.authorized));
    expect(t.cards()).toEqual([]);

    t.tg.allow(t.tg.token);
    await t.card(0);
    await t.host.restart();
    await t.host.until(() => t.tg.of("getUpdates").length > 1);
    await Bun.sleep(200);
    expect(t.cards()).toHaveLength(1);
  });
});

describe("a parked routine run", () => {
  async function setup(t: Started) {
    await t.link();
    await t.addMail();
    const botId = t.host.createBot("Planner");
    const other = t.host.createBot("Other");
    const created = await t.host.ui("/api/routines/create", {
      botId,
      name: "nightly",
      instruction: "mail Ana",
      schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
    });
    const routineId = ((await created.json()) as { id: string }).id;
    // Another bot is shown, so the planner has no chat and its run is headless.
    expect((await t.host.ui("/api/open", { botId: other })).status).toBe(200);
    return { botId, routineId };
  }
  const runs = async (t: Started, routineId: string) =>
    (await (await t.host.ui("/api/routines/runs", { id: routineId })).json()) as Run[];
  const untilRun = async (t: Started, routineId: string, status: string) => {
    for (let i = 0; i < 200 && (await runs(t, routineId))[0]?.status !== status; i++)
      await Bun.sleep(25);
    expect((await runs(t, routineId))[0]?.status).toBe(status);
  };
  const park = async (t: Started, routineId: string) => {
    expect((await t.host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
    await untilRun(t, routineId, "waiting");
  };
  const resultMessages = (t: Started, botId: string) =>
    t.host.messagesOf(botId).filter((m) => m.includes("<human-wait-result"));

  test("Allow on the card resumes the same session once and the run succeeds", async () => {
    const t = await start();
    const { botId, routineId } = await setup(t);
    t.host.approveOnMessage(TOOL, INPUT);
    await park(t, routineId);
    const c = await t.card(0);
    expect(t.text(c)).toContain(JSON.stringify(INPUT, null, 2));
    expect(t.host.messagesOf(botId)).toHaveLength(1);

    expect(await t.press(c, "Allow")).toBe("Answered");
    await untilRun(t, routineId, "succeeded");
    expect(t.host.messagesOf(botId)).toHaveLength(2);
    expect(resultMessages(t, botId)[0]).toContain("Call mcp__fx__send_mail again");
    expect(t.host.messagesOf(botId)[1]).not.toContain("<scheduled-routine");
    await t.host.until(() => t.host.permissionResults().length === 2);
    expect(t.host.permissionResults()[1]).toMatchObject({ response: { behavior: "allow" } });
    expect(await t.edited(c)).toEndWith("Answered: Allow");
    expect(await runs(t, routineId)).toHaveLength(1);

    // A second press, or one on the web, changes nothing.
    expect(await t.pressData(c, t.dataOf(await t.card(0), "Deny"))).toBe("already handled");
    expect(t.host.messagesOf(botId)).toHaveLength(2);
  });

  test("Deny resumes the run with the denial", async () => {
    const t = await start();
    const { botId, routineId } = await setup(t);
    t.host.approveOnMessage(TOOL, INPUT);
    await park(t, routineId);
    t.host.stopApproving();
    expect(await t.press(await t.card(0), "Deny")).toBe("Answered");
    await untilRun(t, routineId, "succeeded");
    expect(resultMessages(t, botId)[0]).toContain("The user denied mcp__fx__send_mail");
  });

  test("a reply to the card is the note the bot receives", async () => {
    const t = await start();
    const { botId, routineId } = await setup(t);
    t.host.approveOnMessage(TOOL, INPUT);
    await park(t, routineId);
    t.host.stopApproving();
    await t.say("not at night", await t.card(0));
    await untilRun(t, routineId, "succeeded");
    expect(resultMessages(t, botId)).toHaveLength(1);
    expect(resultMessages(t, botId)[0]).toContain("The user denied mcp__fx__send_mail");
    expect(resultMessages(t, botId)[0]).toContain("not at night");
  });

  test("a press on the phone and an answer on the web resume the run once", async () => {
    const t = await start();
    const { botId, routineId } = await setup(t);
    t.host.approveOnMessage(TOOL, INPUT);
    await park(t, routineId);
    t.host.stopApproving();
    const c = await t.card(0);
    const [web, phone] = await Promise.all([
      t.host.ui("/api/answer", { id: t.waitId(c), value: "allow" }),
      t.pressData(c, t.dataOf(c, "Allow")),
    ]);
    expect([web.status === 200, phone === "Answered"].filter(Boolean)).toHaveLength(1);
    await untilRun(t, routineId, "succeeded");
    expect(resultMessages(t, botId)).toHaveLength(1);
    expect(t.host.messagesOf(botId)).toHaveLength(2);
  });

  test("an answer after restart() resumes the run, and the card is not sent again", async () => {
    const t = await start();
    const { botId, routineId } = await setup(t);
    t.host.approveOnMessage(TOOL, INPUT);
    await park(t, routineId);
    const c = await t.card(0);

    await t.host.restart();
    t.host.stopApproving();
    await t.host.until(() => t.tg.of("getUpdates").length > 1);
    await Bun.sleep(150);
    expect(t.cards()).toHaveLength(1);
    expect((await runs(t, routineId))[0]?.status).toBe("waiting");

    expect(await t.press(c, "Allow")).toBe("Answered");
    await untilRun(t, routineId, "succeeded");
    expect(resultMessages(t, botId)).toHaveLength(1);
    expect(t.host.messagesOf(botId)).toHaveLength(2);
  });

  test("a press after the 24 hours is refused and edits the card to Expired", async () => {
    const t = await start();
    const { routineId } = await setup(t);
    t.host.approveOnMessage(TOOL, INPUT);
    await park(t, routineId);
    const c = await t.card(0);
    const allow = t.dataOf(c, "Allow");

    t.host.stopApproving();
    // The sweep has not run yet: the wait is still open, though overdue.
    t.host.advanceClock(DAY + 1000);
    expect(await t.pressData(c, allow)).toBe("that wait expired");
    expect(await t.edited(c)).toEndWith("Expired");
    await untilRun(t, routineId, "failed");
    expect((await runs(t, routineId))[0]?.error).toBe("approval expired");
    expect(await t.pressData(c, allow)).toBe("already handled");
  });

  test("expiry at the next start edits the card to Expired", async () => {
    const t = await start();
    const { routineId } = await setup(t);
    t.host.approveOnMessage(TOOL, INPUT);
    await park(t, routineId);
    const c = await t.card(0);

    t.host.stopApproving();
    t.host.advanceClock(DAY + 1000);
    await t.host.restart();
    expect(await t.edited(c)).toEndWith("Expired");
  });

  test("a question on a bot that is not open is a card with option buttons, and its answer resumes the run", async () => {
    const t = await start();
    const { botId, routineId } = await setup(t);
    t.host.askOnMessage("Which list?", ["List A", "List B"]);
    await park(t, routineId);
    const c = await t.card(0);
    expect(t.text(c)).toStartWith("Planner asks: Which list?");
    expect(t.labels(c)).toEqual(["List A", "List B"]);

    t.host.stopAsking();
    expect(await t.press(c, "List B")).toBe("Answered");
    await untilRun(t, routineId, "succeeded");
    expect(resultMessages(t, botId)[0]).toContain("List B");
    expect(await t.edited(c)).toEndWith("Answered: List B");
  });
});
