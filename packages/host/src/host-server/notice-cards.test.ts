import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelLinkCodeResponse } from "@claudebot/contract/api";

import { fakeChannel, type FakeChannel } from "../testing/fake-channel.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

const DAY = 24 * 60 * 60_000;
const owner = { id: "u1", label: "Owner" };
const stranger = { id: "u2", label: "Stranger" };

let host: HandoffHost;
let fake: FakeChannel;
let scratch: string;
let page: EventsWatch | undefined;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "notice-cards-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
});
afterEach(async () => {
  page?.stop();
  page = undefined;
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

/** A host with a fake channel and a public URL a phone could open; the absence check runs every 20 ms against a clock only the test moves. */
async function start(flags: string[] = []) {
  fake = fakeChannel();
  host = await startHandoffHost(
    ["--public-url", "https://claudebot.example.com", ...flags],
    undefined,
    undefined,
    { channelAdapters: (receive) => fake.adapters(receive), absenceCheckMs: 20 },
  );
}

async function link() {
  const res = await host.ui("/api/channels/link-code", { channel: "fake" });
  const { code } = ChannelLinkCodeResponse.parse(await res.json());
  await fake.inject({ from: owner, text: code });
  expect(host.server.channels.linkOf("fake")).toEqual(owner);
}

type Notice = { id: string; title: string; state: string };
const notices = (botId: string) =>
  host.db
    .query<Notice, [string]>(
      "SELECT id, title, state FROM external_events WHERE kind = 'notice' AND bot_id = ? ORDER BY rowid",
    )
    .all(botId);

const routineState = (name: string) =>
  host.db
    .query<{ active: number; paused_reason: string | null }, [string]>(
      "SELECT active, paused_reason FROM routines WHERE name = ?",
    )
    .get(name);

const createRoutine = async (botId: string, name: string) => {
  const created = await host.ui("/api/routines/create", {
    botId,
    name,
    instruction: "check the prices",
    schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
  });
  expect(created.status).toBe(200);
  return ((await created.json()) as { id: string }).id;
};

/** Runs the routine by hand, with a fake CLI that crashes every turn, until its failures pause it. */
async function failFive(botId: string, id: string) {
  host.loopScript(...Array.from({ length: 12 }, () => ({ steps: [{ exit: 1 }] })));
  for (let i = 0; i < 5; i++) {
    const runs = async () =>
      (await (await host.ui("/api/routines/runs", { id })).json()) as unknown[];
    const before = (await runs()).length;
    expect((await host.ui("/api/routines/run", { id })).status).toBe(200);
    for (let n = 0; n < 400; n++) {
      const list = (await (await host.ui("/api/routines/list", { botId })).json()) as {
        id: string;
        running: boolean;
      }[];
      if ((await runs()).length === before + 1 && !list.find((r) => r.id === id)?.running) break;
      await Bun.sleep(25);
    }
  }
}

// The negative checks wait a few real check intervals: there is no event for a check or a send that did nothing.

/** What the adapter has been sent as cards: a message with buttons. */
const cardsSent = () => fake.sent.filter((s) => s.message.buttons !== undefined);
/** The card's edit history as the texts it was edited to. */
const editsOf = (ref: string) =>
  fake.edited.filter((e) => e.ref === ref).map((e) => e.message.text);

const pressOn = (ref: string, data: string, from = owner) =>
  fake.inject({ from, button: { data, on: ref } });

describe("a failures notice on the channel", () => {
  /** A bot whose routine paused after 5 failures, with the channel linked afterwards so the card is the one that waited for a link. */
  async function pausedBot() {
    await start();
    const botId = host.createBot("Planner");
    const id = await createRoutine(botId, "nightly");
    page = await watchEvents(host);
    await failFive(botId, id);
    await host.until(() => notices(botId).length === 1);
    await link();
    await host.until(() => cardsSent().length === 1);
    return { botId, routineId: id, card: cardsSent()[0]! };
  }

  test("goes out as a card with its title, its body, Dismiss only and a link to the routines settings", async () => {
    const { botId, card } = await pausedBot();
    expect(card.to).toEqual(owner);
    expect(card.message.text).toStartWith("Claudebot · nightly paused after 5 failed runs\n\n");
    expect(card.message.text).not.toContain("Reply to this message");
    expect(card.message.buttons?.map((row) => row.map((b) => b.label))).toEqual([["Dismiss"]]);
    expect(card.message.link).toEqual({
      label: "Open in Claudebot",
      url: `https://claudebot.example.com/bots/${botId}?panel=settings&section=routines`,
    });
    // Once, however long the host runs.
    await Bun.sleep(100);
    expect(cardsSent()).toHaveLength(1);
  });

  test("Dismiss on the channel closes it, edits the card and closes it in the web UI, and the bot hears nothing", async () => {
    const { botId, card } = await pausedBot();
    const heard = host.messagesOf(botId).length;
    await host.until(() => page!.needsYou(botId) === 1);

    const reply = await pressOn(card.ref, card.message.buttons![0]![0]!.data);
    expect(reply).toEqual({ toast: "Dismissed" });
    expect(notices(botId)[0]?.state).toBe("dismissed");
    await host.until(() => page!.needsYou(botId) === 0);
    await host.until(() => editsOf(card.ref).length === 1);
    expect(editsOf(card.ref)[0]).toEndWith("Dismissed");
    expect(fake.edited[0]!.message.buttons).toBeUndefined();
    expect(host.messagesOf(botId)).toHaveLength(heard);
  });

  test("Dismiss in the web UI edits the card", async () => {
    const { botId, card } = await pausedBot();
    const res = await host.ui("/api/bots/events/dismiss", { botId, id: notices(botId)[0]!.id });
    expect(await res.json()).toEqual({ closed: true });
    await host.until(() => editsOf(card.ref).length === 1);
    expect(editsOf(card.ref)[0]).toEndWith("Dismissed");
  });

  test("resuming the routine closes the notice as resolved and edits its card", async () => {
    const { botId, routineId, card } = await pausedBot();
    const resumed = await host.ui("/api/routines/update", { id: routineId, active: true });
    expect(await resumed.json()).toMatchObject({ active: true, pausedReason: null });
    expect(notices(botId)[0]?.state).toBe("resolved");
    await host.until(() => editsOf(card.ref).length === 1);
    expect(editsOf(card.ref)[0]).toEndWith("Resolved");
    // A press of the old button is out of date now, not an error.
    expect(await pressOn(card.ref, card.message.buttons![0]![0]!.data)).toEqual({
      toast: "already handled",
    });
  });

  test("words are never sent to the bot: a reply to the card and a plain message both get a refusal and leave the notice open", async () => {
    const { botId, card } = await pausedBot();
    const heard = host.messagesOf(botId).length;

    const replied = await fake.inject({ from: owner, text: "retry it", replyTo: card.ref });
    expect(replied.send?.[0]?.text).toContain("takes no reply");
    const plain = await fake.inject({ from: owner, text: "retry it" });
    expect(plain.send?.[0]?.text).toContain("takes no reply");

    await Bun.sleep(100);
    expect(host.messagesOf(botId)).toHaveLength(heard);
    expect(notices(botId)[0]?.state).toBe("open");
    expect(fake.edited).toEqual([]);
  });

  test("a notice raised after the link is sent at once", async () => {
    await start();
    await link();
    const botId = host.createBot("Planner");
    const id = await createRoutine(botId, "nightly");
    await failFive(botId, id);
    await host.until(() => cardsSent().length === 1);
    expect(cardsSent()[0]!.message.text).toContain("nightly paused after 5 failed runs");
  });
});

describe("the absence pause on the channel", () => {
  const FLAGS = ["--pause-after-absence-days", "14"];

  /** One bot with one active routine and a linked channel. The setup requests count as the owner being here, at the clock's start. */
  async function away() {
    await start(FLAGS);
    const botId = host.createBot("Planner");
    await createRoutine(botId, "nightly");
    await link();
    expect(routineState("nightly")).toEqual({ active: 1, paused_reason: null });
    return botId;
  }

  test("the warning and then the pause arrive as cards, each once", async () => {
    const botId = await away();
    host.advanceClock(12 * DAY);
    await host.until(() => cardsSent().length === 1);
    expect(cardsSent()[0]!.message.text).toContain(
      "Routines will pause in 2 days unless you open claudebot",
    );
    expect(cardsSent()[0]!.message.text).toContain("nightly");
    expect(cardsSent()[0]!.message.buttons?.map((row) => row.map((b) => b.label))).toEqual([
      ["Dismiss"],
    ]);

    host.advanceClock(2 * DAY);
    await host.until(() => routineState("nightly")?.paused_reason === "absence");
    await host.until(() => cardsSent().length === 2);
    expect(cardsSent()[1]!.message.text).toContain("Routines paused: no activity for 14 days");
    expect(cardsSent()[1]!.message.link?.url).toEndWith(
      `/bots/${botId}?panel=settings&section=routines`,
    );
    await Bun.sleep(150);
    expect(cardsSent()).toHaveLength(2);
  });

  test("a message from the linked account resumes the routines and closes both cards; one from another account does not", async () => {
    const botId = await away();
    host.advanceClock(12 * DAY);
    await host.until(() => cardsSent().length === 1);
    host.advanceClock(2 * DAY);
    await host.until(() => routineState("nightly")?.paused_reason === "absence");
    await host.until(() => cardsSent().length === 2);

    // Not the owner: nothing resumes, nothing is sent, the cards stay.
    expect(await fake.inject({ from: stranger, text: "hello" })).toEqual({});
    await Bun.sleep(150);
    expect(routineState("nightly")).toEqual({ active: 0, paused_reason: "absence" });
    expect(notices(botId).every((n) => n.state === "open")).toBe(true);
    expect(fake.edited).toEqual([]);

    // The owner says anything: no card takes the words, and it is presence all the same.
    await fake.inject({ from: owner, text: "I am back" });
    await host.until(() => routineState("nightly")?.paused_reason === null);
    expect(routineState("nightly")?.active).toBe(1);
    expect(notices(botId).map((n) => n.state)).toEqual(["resolved", "resolved"]);
    await host.until(() => fake.edited.length === 2);
    expect(fake.edited.map((e) => e.message.text.split("\n\n").at(-1))).toEqual([
      "Resolved",
      "Resolved",
    ]);
  });

  test("a button press from the linked account is presence too", async () => {
    await away();
    host.advanceClock(14 * DAY);
    await host.until(() => routineState("nightly")?.paused_reason === "absence");
    await host.until(() => cardsSent().length === 1);

    const pause = cardsSent()[0]!;
    await pressOn(pause.ref, pause.message.buttons![0]![0]!.data);
    await host.until(() => routineState("nightly")?.paused_reason === null);
  });
});
