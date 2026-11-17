import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelLinkCodeResponse, type EventAccess } from "@tomte/contract/api";

import { createBot, getOrigin, setChatMode } from "../bots/index.ts";
import { migrate } from "../platform/db.ts";
import { fakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import type { SendOutcome } from "./chats.ts";
import { createPhoneChat } from "./phone-chat.ts";

/** Spins until the clock reads a later millisecond, so two bots never share a creation time. */
function nextMillisecond() {
  const start = Date.now();
  while (Date.now() === start);
}

const owner = { id: 4242, first_name: "Owner", last_name: "One" };
const hosts: HandoffHost[] = [];
const fakes: FakeTelegram[] = [];
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "phone-chat-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
});
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const f of fakes.splice(0)) await f.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

type Mode = "standard" | "double_loop";

/** A host linked to a fake Telegram account, with the owner's side of the conversation as helpers. */
async function start() {
  const tg = fakeTelegram();
  fakes.push(tg);
  const host = await startHandoffHost([], undefined, undefined, {
    telegram: { baseUrl: tg.url, pollTimeoutSeconds: 30, sendSpacingMs: 10, backoffMs: 20 },
    cards: { retryMs: 30 },
    notices: { retryMs: 20 },
  });
  hosts.push(host);

  /** Waits until the adapter has confirmed the update, so what it did about it is done. */
  const handled = (id: number) =>
    host.until(() =>
      tg.of("getUpdates").some((c) => typeof c.params.offset === "number" && c.params.offset > id),
    );
  expect((await host.ui("/api/channels/telegram/token", { token: tg.token })).status).toBe(200);
  await host.until(() => tg.of("getUpdates").length > 0);
  const linked = await host.ui("/api/channels/link-code", { channel: "telegram" });
  await handled(tg.message(owner, ChannelLinkCodeResponse.parse(await linked.json()).code));

  /** A bot in the mode, made in a later millisecond than any made before it so "newest" is never a tie. */
  const bot = async (name: string, mode: Mode = "standard") => {
    nextMillisecond();
    const id = host.createBot(name);
    if (mode === "double_loop") setChatMode(host.dataRoot, id, "double_loop");
    return id;
  };
  /** What a bot said to the phone: the messages that start with its name and a blank line. */
  const repliesOf = (name: string) => tg.texts().filter((t) => t.startsWith(`${name}\n\n`));
  const say = (text: string) => handled(tg.message(owner, text));
  /** The bot got the message (a double-loop front's carries the work state after it). */
  const received = (botId: string, text: string) =>
    host.messagesOf(botId).some((m) => m.startsWith(text));
  const idle = (botId: string) => host.until(() => !host.server.isWorking(botId));
  /** The bot's turn on a host message: an external event reaches it with no owner message at all. */
  const notify = async (botId: string) => {
    const { token } = (await (
      await host.ui("/api/bots/events-token", { botId })
    ).json()) as EventAccess;
    const res = await fetch(`${host.clientUrl}/api/bots/${botId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: "done",
        key: crypto.randomUUID(),
        source: { id: "ci", label: "ci" },
        title: "Build finished",
      }),
    });
    expect(res.status).toBe(202);
  };
  return { tg, host, handled, bot, repliesOf, say, received, idle, notify };
}

describe.each<Mode>(["standard", "double_loop"])(
  "a bot in %s mode, talked to from the phone",
  (mode) => {
    test("@Name sends the rest to that bot only, and its reply comes back with its name first and no link on a loopback URL", async () => {
      const t = await start();
      const scout = await t.bot("Job scout", mode);
      const job = await t.bot("Job", mode);

      await t.say("@job   SCOUT: what is new?");
      await t.host.until(() => t.received(scout, "what is new?"));
      await t.host.until(() => t.repliesOf("Job scout").length === 1);

      expect(t.repliesOf("Job scout")).toEqual(["Job scout\n\nok"]);
      const sent = t.tg.of("sendMessage").find((c) => c.params.text === "Job scout\n\nok")!;
      expect(sent.params.reply_markup).toBeUndefined();
      expect(t.host.messagesOf(job)).toEqual([]);
      expect(t.tg.of("editMessageText")).toEqual([]);
    });

    test("the longest name wins: @Job scout reaches Job scout while a bot named Job exists", async () => {
      const t = await start();
      const job = await t.bot("Job", mode);
      const scout = await t.bot("Job scout", mode);

      await t.say("@Job scout hello");
      await t.host.until(() => t.received(scout, "hello"));
      await t.say("@Job scouting");
      await t.host.until(() => t.received(job, "scouting"));
      expect(t.received(job, "hello")).toBe(false);
    });

    test("replies stop going to the phone once the owner writes to the bot in the web UI, and start again with the next phone message", async () => {
      const t = await start();
      const botId = await t.bot("Planner", mode);

      await t.say("@Planner first");
      await t.host.until(() => t.repliesOf("Planner").length === 1);
      await t.idle(botId);

      expect((await t.host.ui("/api/open", { botId })).status).toBe(200);
      expect((await t.host.ui("/api/send", { text: "from the laptop" })).status).toBe(200);
      await t.host.until(() => t.received(botId, "from the laptop"));
      await t.idle(botId);
      // Replies are sent in order, so a stray one would come before this hint, which proves it never came.
      await t.say("hello?");
      await t.host.until(() => t.tg.texts().some((x) => x.startsWith("To talk to a bot")));
      expect(t.repliesOf("Planner")).toHaveLength(1);

      await t.say("@Planner again");
      await t.host.until(() => t.repliesOf("Planner").length === 2);
    });

    test("replies still reach the phone after the host restarts", async () => {
      const t = await start();
      const botId = await t.bot("Planner", mode);
      await t.say("@Planner first");
      await t.host.until(() => t.repliesOf("Planner").length === 1);
      await t.idle(botId);

      await t.host.restart();
      await t.host.until(() => t.tg.of("getUpdates").length > 0);
      // Nothing the owner wrote: the bot answers a message the host gave it, and the phone still has the conversation.
      await t.notify(botId);
      await t.host.until(() => t.repliesOf("Planner").length === 2);
    });

    test("a message with no bot name and no open card gets a hint naming the newest bot, and reaches no bot", async () => {
      const t = await start();
      const older = await t.bot("Older", mode);
      const newest = await t.bot("Newest", mode);

      await t.say("hello?");
      await t.host.until(() =>
        t.tg.texts().includes("To talk to a bot, start with @ and its name, for example @Newest."),
      );
      expect(t.host.messagesOf(older)).toEqual([]);
      expect(t.host.messagesOf(newest)).toEqual([]);
    });

    test("an @ that matches no bot lists the bots' names and reaches none", async () => {
      const t = await start();
      const only = await t.bot("Planner", mode);
      await t.say("@Plannner hello");
      await t.host.until(() =>
        t.tg
          .texts()
          .includes(
            "No bot has that name. Your bots: Planner. Start with @ and a bot's full name.",
          ),
      );
      expect(t.host.messagesOf(only)).toEqual([]);
    });
  },
);

describe("a standard bot", () => {
  test("a message to a busy bot is queued as on the web, the owner is told, and both replies reach the phone", async () => {
    const t = await start();
    const botId = await t.bot("Planner");
    t.host.hold();

    await t.say("@Planner first");
    await t.host.until(() => t.received(botId, "first"));
    await t.say("@Planner second");
    await t.host.until(() => t.tg.texts().includes("queued; the bot is busy"));
    expect(t.received(botId, "second")).toBe(false);

    t.host.release();
    await t.host.until(() => t.repliesOf("Planner").length === 2);
    expect(t.received(botId, "second")).toBe(true);
  });

  test("a message never answers a pending question about an item: the question stays open", async () => {
    const t = await start();
    const botId = await t.bot("Planner");
    await t.host.ui("/api/open", { botId });
    t.host.askOnMessage("Which database?", ["Postgres", "SQLite"], { delivered: true });
    await t.notify(botId);
    await t.host.until(() => t.host.server.isWorking(botId));
    await t.host.until(() => t.tg.of("sendMessage").some((c) => c.params.reply_markup));

    await t.say("@Planner Postgres");
    await t.host.until(() => t.tg.texts().includes("queued; the bot is busy"));
    expect(t.host.toolResults()).toEqual([]);
  });
});

describe("a double-loop bot", () => {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const AGENT_CALL = {
    subagent_type: "researcher",
    description: "research X",
    prompt: "Find out about X.",
    run_in_background: true,
  };
  const REPORT = "X costs $20 a month on every plan.";
  const researchScript = {
    match: "research X",
    steps: [
      {
        emit: {
          type: "assistant",
          message: {
            id: "msg_tu-agent",
            type: "message",
            role: "assistant",
            model: "fake",
            content: [{ type: "tool_use", id: "tu-agent", name: "Agent", input: AGENT_CALL }],
            stop_reason: "tool_use",
            usage,
          },
          parent_tool_use_id: null,
        },
      },
      {
        hook: "PreToolUse",
        tool_use_id: "tu-agent",
        input: { tool_name: "Agent", tool_input: AGENT_CALL, tool_use_id: "tu-agent" },
      },
      {
        emit: {
          type: "system",
          subtype: "task_started",
          task_id: "agent-1",
          tool_use_id: "tu-agent",
          description: "research X",
          subagent_type: "researcher",
        },
      },
      { text: "On it." },
      { result: "On it." },
      { waitFor: "finish" },
      {
        hook: "SubagentStop",
        input: {
          agent_id: "agent-1",
          agent_type: "researcher",
          agent_transcript_path: "",
          stop_hook_active: false,
          last_assistant_message: REPORT,
        },
      },
      {
        emit: {
          type: "system",
          subtype: "task_notification",
          task_id: "agent-1",
          status: "completed",
          output_file: "",
          summary: "done",
        },
      },
    ],
  };

  test("an agent's report reaches the phone as the bot's message, after the front's own reply", async () => {
    const t = await start();
    const botId = await t.bot("Dev", "double_loop");
    t.host.loopScript(researchScript);

    await t.say("@Dev research X");
    await t.host.until(() => t.repliesOf("Dev").includes("Dev\n\nOn it."));
    expect(t.repliesOf("Dev")).not.toContain(`Dev\n\n${REPORT}`);

    t.host.allow("finish");
    await t.host.until(() => t.repliesOf("Dev").includes(`Dev\n\n${REPORT}`));
    await t.idle(botId);
  });

  test("a message is sent to the front, never queued, even while an agent runs", async () => {
    const t = await start();
    const botId = await t.bot("Dev", "double_loop");
    t.host.loopScript(researchScript);

    await t.say("@Dev research X");
    await t.host.until(() => t.repliesOf("Dev").includes("Dev\n\nOn it."));
    await t.say("@Dev how is it going");
    await t.host.until(() => t.received(botId, "how is it going"));
    expect(t.tg.texts()).not.toContain("queued; the bot is busy");
    t.host.allow("finish");
    await t.idle(botId);
  });
});

describe("the chat the phone's messages go through", () => {
  /** A phone chat over a stub of the host's send, with a database and one bot in a data root of its own. */
  function chatWith(outcome: SendOutcome) {
    const db = migrate(new Database(":memory:"));
    const bot = createBot(join(scratch, "ws"), "Planner");
    const sent: string[] = [];
    const chat = createPhoneChat({
      dataRoot: join(scratch, "ws"),
      db,
      chats: {
        send: async (_id, text) => {
          sent.push(text);
          return outcome;
        },
      },
      now: () => 77,
    });
    return { db, bot, chat, sent };
  }

  test("a send the bot refused is reported as it is and leaves the bot's origin alone", async () => {
    const { db, bot, chat, sent } = chatWith({ outcome: "refused", reason: "no such bot" });
    expect(await chat.send(bot.id, "hello", "telegram")).toEqual({
      outcome: "refused",
      reason: "no such bot",
    });
    expect(sent).toEqual(["hello"]);
    expect(getOrigin(db, bot.id)).toBeUndefined();
  });

  test("a send that reached the bot, or its queue, makes the channel the bot's origin", async () => {
    for (const outcome of [{ outcome: "sent" }, { outcome: "queued", queued: "q1" }] as const) {
      const { db, bot, chat } = chatWith(outcome);
      await chat.send(bot.id, "hello", "telegram");
      expect(getOrigin(db, bot.id)).toBe("telegram");
    }
  });

  test("the bots are listed newest first", async () => {
    const { bot, chat } = chatWith({ outcome: "sent" });
    nextMillisecond();
    const newer = createBot(join(scratch, "ws"), "Newer");
    expect(chat.bots()).toEqual([
      { id: newer.id, name: "Newer" },
      { id: bot.id, name: "Planner" },
    ]);
  });
});
