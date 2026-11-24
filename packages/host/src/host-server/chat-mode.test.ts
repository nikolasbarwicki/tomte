import { afterEach, beforeEach, expect, test } from "bun:test";

import { BotsEvent } from "@tomte/contract/events";

import { getBot } from "../bots/index.ts";
import { createLoopStore } from "../loop/index.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

let host: HandoffHost;
beforeEach(async () => {
  host = await startHandoffHost();
});
afterEach(() => host.stop());

const setMode = (botId: string, chatMode: string) =>
  host.ui("/api/bots/chat-mode", { botId, chatMode });
const modeOf = (botId: string) => defined(getBot(host.dataRoot, botId), "bot").chatMode;
const sessionsOf = (botId: string) => defined(getBot(host.dataRoot, botId), "bot").sessions.length;
/** The bot's entry in the `bots` event a page connecting now is sent first. */
async function summaryOf(botId: string) {
  const abort = new AbortController();
  const res = await fetch(`${host.clientUrl}/api/events`, {
    signal: abort.signal,
    headers: host.authHeaders,
  });
  if (!res.body) throw new Error("no event stream");
  const reader = res.body.getReader();
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the event stream ended before a bots event");
      text += new TextDecoder().decode(chunk.value);
      for (const part of text.split("\n\n")) {
        if (!part.startsWith("data: ")) continue;
        for (const event of eventsOf(part.slice(6)) as { type: string }[]) {
          if (event.type === "bots")
            return defined(
              BotsEvent.parse(event).bots.find((b) => b.id === botId),
              "bot summary",
            );
        }
      }
    }
  } finally {
    abort.abort();
  }
}

test("a new bot chats in standard mode, and the bots event carries the mode", async () => {
  const bot = host.createBot("Ada");
  expect(modeOf(bot)).toBe("standard");
  expect((await summaryOf(bot)).chatMode).toBe("standard");
});

test("switching persists the mode across a host restart, starts a new session and announces it", async () => {
  const bot = host.createBot("Ada");
  expect((await host.ui("/api/open", { botId: bot })).status).toBe(200);

  expect((await setMode(bot, "background_tasks")).status).toBe(200);
  expect(modeOf(bot)).toBe("background_tasks");
  expect(sessionsOf(bot)).toBe(2);
  expect((await summaryOf(bot)).chatMode).toBe("background_tasks");

  await host.restart();
  expect(modeOf(bot)).toBe("background_tasks");
  expect((await summaryOf(bot)).chatMode).toBe("background_tasks");

  expect((await setMode(bot, "standard")).status).toBe(200);
  expect(modeOf(bot)).toBe("standard");
  expect(sessionsOf(bot)).toBe(3);
});

test("switching a bot that has no open chat persists the mode and starts a new session", async () => {
  const shown = host.createBot("Shown");
  const other = host.createBot("Other");
  expect((await host.ui("/api/open", { botId: shown })).status).toBe(200);

  expect((await setMode(other, "background_tasks")).status).toBe(200);
  expect(modeOf(other)).toBe("background_tasks");
  expect(sessionsOf(other)).toBe(2);
});

test("setting the mode a bot already has succeeds and keeps its conversation", async () => {
  const bot = host.createBot("Ada");
  expect((await host.ui("/api/open", { botId: bot })).status).toBe(200);
  expect((await setMode(bot, "standard")).status).toBe(200);
  expect(sessionsOf(bot)).toBe(1);
});

test("an unknown bot answers 404 and an unknown mode 400", async () => {
  const bot = host.createBot("Ada");
  expect((await setMode("nope", "background_tasks")).status).toBe(404);
  expect((await setMode(bot, "triple_loop")).status).toBe(400);
  expect(modeOf(bot)).toBe("standard");
});

test("a bot with running or queued background tasks refuses to switch, and nothing changes", async () => {
  const bot = host.createBot("Ada");
  expect((await host.ui("/api/open", { botId: bot })).status).toBe(200);
  expect((await setMode(bot, "background_tasks")).status).toBe(200);
  const session = defined(getBot(host.dataRoot, bot)?.sessions.at(-1), "session");
  const tasks = createLoopStore(host.db).session(bot, session);
  tasks.putTask({ taskId: "t1", goal: "research", status: "running", startedAt: 1 }, 1);

  const refused = await setMode(bot, "standard");
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain("stop the running tasks first");
  expect(modeOf(bot)).toBe("background_tasks");
  expect(sessionsOf(bot)).toBe(2);

  expect((await setMode(bot, "background_tasks")).status).toBe(200);

  tasks.putTask({ taskId: "t1", goal: "research", status: "queued", startedAt: 1 }, 2);
  expect((await setMode(bot, "standard")).status).toBe(409);

  tasks.setStatus("t1", "done", 3);
  expect((await setMode(bot, "standard")).status).toBe(200);
});

test("a bot in the middle of a turn refuses to switch", async () => {
  const bot = host.createBot("Ada");
  expect((await host.ui("/api/open", { botId: bot })).status).toBe(200);
  host.hold();
  expect((await host.ui("/api/send", { text: "work" })).status).toBe(200);
  await host.until(() => host.messagesOf(bot).length === 1);

  expect((await setMode(bot, "background_tasks")).status).toBe(409);
  expect(modeOf(bot)).toBe("standard");
  expect(sessionsOf(bot)).toBe(1);
  host.release();
});

test("a stale in-memory bot never overwrites the stored mode when its session is saved", async () => {
  const bot = host.createBot("Ada");
  expect((await host.ui("/api/open", { botId: bot })).status).toBe(200);
  expect((await setMode(bot, "background_tasks")).status).toBe(200);
  expect((await host.ui("/api/session/new", {})).status).toBe(200);
  expect(modeOf(bot)).toBe("background_tasks");
  expect(sessionsOf(bot)).toBe(3);
});
