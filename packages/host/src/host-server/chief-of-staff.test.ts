import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Bot, BotsEvent } from "@tomte/contract/events";

import { getBot } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

let host: HandoffHost;
beforeEach(async () => {
  host = await startHandoffHost();
});
afterEach(() => host.stop());

const SECTION = "You are the owner's Chief of Staff";
const AVATAR = { shape: "cone", color: "teal" } as const;

const flagOf = (id: string) => defined(getBot(host.dataRoot, id), "bot").chiefOfStaff;

/** Saves the bot's profile as the page does: its current name and purpose, with the switch. */
function setSwitch(id: string, chiefOfStaff: boolean) {
  const bot = defined(getBot(host.dataRoot, id), "bot");
  return host.ui("/api/bots/profile", {
    botId: id,
    name: bot.name,
    purpose: bot.purpose,
    ...AVATAR,
    chiefOfStaff,
  });
}

/** The bots event a page connecting now is sent first. */
async function summaries() {
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
          if (event.type === "bots") return BotsEvent.parse(event).bots;
        }
      }
    }
  } finally {
    abort.abort();
  }
}
const flaggedInSummaries = async () =>
  (await summaries()).filter((b) => b.chiefOfStaff).map((b) => b.name);

const promptOf = (n: number) => defined(host.launches()[n], `launch ${n}`).appendSystemPrompt ?? "";

/** Sends a message to the open bot and waits until the fake CLI has received it. */
async function say(botId: string, text: string, delivered: number) {
  expect((await host.ui("/api/send", { text })).status).toBe(200);
  await host.until(() => host.messagesOf(botId).length === delivered);
  await host.until(() => !host.server.isWorking(botId));
}

describe("the switch", () => {
  test("a bot made with it on holds it, and the bots event says so", async () => {
    const ada = host.createBot("Ada");
    const res = await host.ui("/api/bots/new", { name: "Bea", ...AVATAR, chiefOfStaff: true });
    expect(res.status).toBe(200);
    const bea = Bot.parse(await res.json()).id;

    expect(flagOf(bea)).toBe(true);
    expect(flagOf(ada)).toBe(false);
    expect(await flaggedInSummaries()).toEqual(["Bea"]);
  });

  test("a bot made without it, or with it off, does not hold it", async () => {
    const plain = await host.ui("/api/bots/new", { name: "Ada", ...AVATAR });
    const off = await host.ui("/api/bots/new", { name: "Bea", ...AVATAR, chiefOfStaff: false });
    expect(plain.status).toBe(200);
    expect(off.status).toBe(200);
    expect(await flaggedInSummaries()).toEqual([]);
  });

  test("a new bot made with it takes it from the bot that held it", async () => {
    const ada = host.createBot("Ada");
    expect((await setSwitch(ada, true)).status).toBe(200);

    const res = await host.ui("/api/bots/new", { name: "Bea", ...AVATAR, chiefOfStaff: true });
    expect(res.status).toBe(200);
    expect(flagOf(ada)).toBe(false);
    expect(await flaggedInSummaries()).toEqual(["Bea"]);
  });

  test("turning it on through the profile moves it from the other bot, and off clears it", async () => {
    const ada = host.createBot("Ada");
    const bea = host.createBot("Bea");

    const on = await setSwitch(ada, true);
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ id: ada, chiefOfStaff: true });
    expect(await flaggedInSummaries()).toEqual(["Ada"]);

    expect((await setSwitch(bea, true)).status).toBe(200);
    expect(flagOf(ada)).toBe(false);
    expect(flagOf(bea)).toBe(true);
    expect(await flaggedInSummaries()).toEqual(["Bea"]);

    expect((await setSwitch(bea, false)).status).toBe(200);
    expect(await flaggedInSummaries()).toEqual([]);
  });

  test("a profile that leaves the switch as it is changes nothing else", async () => {
    const ada = host.createBot("Ada");
    expect((await setSwitch(ada, true)).status).toBe(200);
    expect((await setSwitch(ada, true)).status).toBe(200);
    expect(flagOf(ada)).toBe(true);
  });

  test("a profile without the switch is refused", async () => {
    const ada = host.createBot("Ada");
    const res = await host.ui("/api/bots/profile", { botId: ada, name: "Ada", ...AVATAR });
    expect(res.status).toBe(400);
  });

  test("the switch survives a host restart", async () => {
    const ada = host.createBot("Ada");
    expect((await setSwitch(ada, true)).status).toBe(200);
    await host.restart();
    expect(await flaggedInSummaries()).toEqual(["Ada"]);
  });
});

describe("the prompt", () => {
  test("a bot that never had the switch has no Chief of Staff section", async () => {
    const ada = host.createBot("Ada", "Writes docs");
    expect((await host.ui("/api/open", { botId: ada })).status).toBe(200);
    await say(ada, "hello", 1);
    expect(promptOf(0)).toContain('You are "Ada"');
    expect(promptOf(0)).not.toContain("Chief of Staff");
  });

  test("the open session reopens with the section after switching on and loses it after switching off", async () => {
    const ada = host.createBot("Ada", "Writes docs");
    expect((await host.ui("/api/open", { botId: ada })).status).toBe(200);
    await say(ada, "hello", 1);
    expect(promptOf(0)).not.toContain(SECTION);

    expect((await setSwitch(ada, true)).status).toBe(200);
    await say(ada, "again", 2);
    await host.until(() => host.launches().length === 2);
    expect(promptOf(1)).toContain(SECTION);
    expect(promptOf(1)).toContain("create_bot");
    // The role adds a section; the bot's own identity stays.
    expect(promptOf(1)).toContain("Your job: Writes docs");

    expect((await setSwitch(ada, false)).status).toBe(200);
    await say(ada, "third", 3);
    await host.until(() => host.launches().length === 3);
    expect(promptOf(2)).not.toContain(SECTION);
  });

  test("the bot that loses the role loses the section too", async () => {
    const ada = host.createBot("Ada");
    const bea = host.createBot("Bea");
    expect((await setSwitch(ada, true)).status).toBe(200);
    expect((await host.ui("/api/open", { botId: ada })).status).toBe(200);
    await say(ada, "hello", 1);
    expect(promptOf(0)).toContain(SECTION);

    expect((await setSwitch(bea, true)).status).toBe(200);
    await say(ada, "again", 2);
    await host.until(() => host.launches().length === 2);
    expect(promptOf(1)).not.toContain(SECTION);
  });

  test("a background-tasks front gets the section", async () => {
    const ada = host.createBot("Ada");
    expect((await host.ui("/api/open", { botId: ada })).status).toBe(200);
    expect(
      (await host.ui("/api/bots/chat-mode", { botId: ada, chatMode: "background_tasks" })).status,
    ).toBe(200);
    expect((await setSwitch(ada, true)).status).toBe(200);
    host.loopScript({ steps: [{ result: "Hi." }] });
    expect((await host.ui("/api/send", { text: "hello" })).status).toBe(200);
    await host.until(() => host.launches().length >= 1);
    expect(promptOf(host.launches().length - 1)).toContain(SECTION);
  });
});
