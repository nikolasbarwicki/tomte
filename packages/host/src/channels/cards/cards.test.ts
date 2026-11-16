import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { migrate } from "../../platform/db.ts";
import { fakeChannel } from "../../testing/fake-channel.ts";
import { createChannels } from "../index.ts";
import { createCards } from "./index.ts";
import type { Answered, CardItem, CardSource, ItemKind } from "./types.ts";

const owner = { id: "u1", label: "Owner" };
const other = { id: "u2", label: "Other" };

interface FakeSource {
  source: CardSource;
  pressed: string[];
  replied: string[];
  answerWith(a: Answered): void;
  open(id: string, extra?: Partial<CardItem>): void;
  close(id: string, outcome: string): void;
}

/** A source of items kept in memory, as a card source that is not an external event: `wait` here stands for any kind added later. */
function fakeSource(kind: ItemKind, prefix: string): FakeSource {
  const items = new Map<string, { item: CardItem; closed?: string }>();
  const pressed: string[] = [];
  const replied: string[] = [];
  let answer: Answered = { outcome: "sent" };
  const source: CardSource = {
    kind,
    prefix,
    open: () => [...items.values()].flatMap((e) => (e.closed === undefined ? [e.item] : [])),
    view(id) {
      const e = items.get(id);
      if (!e) return undefined;
      return e.closed === undefined
        ? { open: true, item: e.item }
        : { open: false, heading: e.item.heading, outcome: e.closed };
    },
    async press(id, arg) {
      pressed.push(`${id}:${arg}`);
      return answer;
    },
    async reply(id, text) {
      replied.push(`${id}:${text}`);
      return answer;
    },
  };
  return {
    source,
    pressed,
    replied,
    answerWith: (a: Answered) => void (answer = a),
    open(id: string, extra: Partial<CardItem> = {}) {
      items.set(id, {
        item: {
          id,
          botId: "b1",
          openedAt: items.size + 1,
          heading: `heading ${id}`,
          buttons: [{ label: "Go", arg: "0" }],
          reply: false,
          ...extra,
        },
      });
    },
    close(id: string, outcome: string) {
      items.get(id)!.closed = outcome;
    },
  };
}

function setup(
  publicUrl = "https://claudebot.example.com",
  sources: FakeSource[] = [fakeSource("event", "a")],
) {
  const db = migrate(new Database(":memory:"));
  const fake = fakeChannel();
  const channels = createChannels({ db, onActivity: () => {} });
  channels.register(fake.channel);
  fake.adapters((kind, inbound) => channels.receive(kind, inbound));
  const cards = createCards({
    db,
    channels,
    sources: sources.map((s) => s.source),
    publicUrl,
    retryMs: 20,
  });
  channels.handle((kind, inbound) => cards.receive(kind, inbound));
  const link = async (from = owner) => fake.inject({ from, text: channels.createLinkCode("fake") });
  const press = (data: string, on = "m1", from = owner) =>
    fake.inject({ from, button: { data, on } });
  const say = (text: string, replyTo?: string, from = owner) =>
    fake.inject({ from, text, ...(replyTo !== undefined && { replyTo }) });
  return { db, fake, channels, cards, sources, link, press, say };
}

describe("sending a card", () => {
  test("an open item is sent once, however often the cards are synced, with its button and a link to the panel", async () => {
    const { fake, cards, sources, link } = setup();
    sources[0]!.open("e1", { botId: "b9", panel: "work" });
    await link();
    await cards.sync();
    await cards.sync();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.message).toEqual({
      text: "heading e1",
      buttons: [[{ label: "Go", data: "a:e1:0" }]],
      link: { label: "Open in Claudebot", url: "https://claudebot.example.com/bots/b9?panel=work" },
    });
  });

  test("nothing is sent while no account is linked; linking sends what waited, oldest first", async () => {
    const { fake, cards, sources, link } = setup();
    sources[0]!.open("e2", { openedAt: 20 });
    sources[0]!.open("e1", { openedAt: 10 });
    await cards.sync();
    expect(fake.sent).toEqual([]);

    await link();
    await cards.sync();
    expect(fake.sent.map((s) => s.message.text)).toEqual(["heading e1", "heading e2"]);
  });

  test("items of every kind are sent in the order they arrived, each with its own button prefix", async () => {
    const events = fakeSource("event", "a");
    const waits = fakeSource("wait", "w");
    const { fake, cards, link } = setup(undefined, [events, waits]);
    events.open("e1", { openedAt: 30 });
    waits.open("w1", { openedAt: 10 });
    waits.open("w2", { openedAt: 40 });
    await link();
    await cards.sync();
    expect(fake.sent.map((s) => s.message.buttons![0]![0]!.data)).toEqual([
      "w:w1:0",
      "a:e1:0",
      "w:w2:0",
    ]);
  });

  test("a card with nothing to press has no buttons, and one that is answered in words says to reply", async () => {
    const { fake, cards, sources, link } = setup();
    sources[0]!.open("e1", { buttons: [], reply: true });
    await link();
    await cards.sync();
    expect(fake.sent[0]!.message.buttons).toBeUndefined();
    expect(fake.sent[0]!.message.text).toBe("heading e1\n\nReply to this message to answer.");
  });

  test("there is no link when the public URL is a loopback http URL, and it follows the panel and the bot otherwise", async () => {
    for (const url of ["http://127.0.0.1:5173", "http://localhost:3000", "http://[::1]:80"]) {
      const { fake, cards, sources, link } = setup(url);
      sources[0]!.open("e1");
      await link();
      await cards.sync();
      expect(fake.sent[0]!.message.link).toBeUndefined();
    }
    const { fake, cards, sources, link } = setup("https://claudebot.example.com");
    sources[0]!.open("e1", { botId: "bot one" });
    await link();
    await cards.sync();
    expect(fake.sent[0]!.message.link?.url).toBe("https://claudebot.example.com/bots/bot%20one");
  });

  test("long text is cut at 3000 characters with an ellipsis, and the card stays plain text", async () => {
    const { fake, cards, sources, link } = setup();
    sources[0]!.open("e1", { heading: "<b>bold</b>", body: "x".repeat(9000), reply: true });
    await link();
    await cards.sync();
    const text = fake.sent[0]!.message.text;
    expect(text.startsWith("<b>bold</b>\n\nxxx")).toBe(true);
    expect(text).toContain("…\n\nReply to this message to answer.");
    expect(text.length).toBeLessThan(3100);
  });

  test("a button whose data would not fit a channel's limit is left out", async () => {
    const { fake, cards, sources, link } = setup();
    sources[0]!.open("x".repeat(70), { reply: true });
    await link();
    await cards.sync();
    expect(fake.sent[0]!.message.buttons).toBeUndefined();
  });

  test("a send that fails is tried again later and sent once", async () => {
    const { fake, cards, sources, link } = setup();
    sources[0]!.open("e1");
    await link();
    const send = fake.channel.send.bind(fake.channel);
    let failures = 2;
    fake.channel.send = async (to, message) => {
      if (failures-- > 0) throw new Error("telegram is down");
      return send(to, message);
    };
    await cards.sync();
    expect(fake.sent).toEqual([]);
    // The retry is a timer of the tracker's own.
    for (let i = 0; i < 200 && fake.sent.length === 0; i++) await Bun.sleep(10);
    expect(fake.sent).toHaveLength(1);
    await cards.sync();
    expect(fake.sent).toHaveLength(1);
    await cards.stop();
  });

  test("another account starts with no cards, so it gets every open item; the same account keeps its own", async () => {
    const { fake, cards, sources, link, channels } = setup();
    sources[0]!.open("e1");
    await link();
    await cards.sync();
    expect(fake.sent).toHaveLength(1);

    await link();
    await cards.sync();
    expect(fake.sent).toHaveLength(1);

    channels.unlink("fake");
    await link(other);
    await cards.sync();
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]!.to).toEqual(other);
  });
});

describe("closing a card", () => {
  test("an item that left open has its card edited to the outcome once, with no buttons and no link", async () => {
    const { fake, cards, sources, link } = setup();
    sources[0]!.open("e1", { panel: "work" });
    await link();
    await cards.sync();

    sources[0]!.close("e1", "Handled");
    await cards.sync();
    await cards.sync();
    expect(fake.edited).toEqual([{ ref: "m1", message: { text: "heading e1\n\nHandled" } }]);
  });

  test("an item that no longer exists is edited too, and an item still open is left alone", async () => {
    const waits = fakeSource("wait", "w");
    const events = fakeSource("event", "a");
    const { fake, cards, link, db } = setup(undefined, [events, waits]);
    events.open("e1");
    waits.open("w1");
    await link();
    await cards.sync();
    db.run("INSERT INTO channel_cards VALUES ('fake', 'event', 'gone', 'b1', 'm9', 1, NULL)");

    waits.close("w1", "Expired");
    await cards.sync();
    expect(
      fake.edited
        .map((e) => [e.ref, e.message.text] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    ).toEqual([
      ["m2", "heading w1\n\nExpired"],
      ["m9", "No longer open"],
    ]);
  });
});

describe("a button", () => {
  test("goes to the source its prefix names, with the item and the button, and the outcome is the toast", async () => {
    const events = fakeSource("event", "a");
    const waits = fakeSource("wait", "w");
    const { cards, link, press } = setup(undefined, [events, waits]);
    events.open("e1");
    waits.open("w1");
    await link();
    await cards.sync();

    expect(await press("w:w1:0")).toEqual({ toast: "Sent" });
    expect(waits.pressed).toEqual(["w1:0"]);
    expect(events.pressed).toEqual([]);

    events.answerWith({ outcome: "queued" });
    expect(await press("a:e1:0")).toEqual({ toast: "queued; the bot is busy" });
    events.answerWith({ outcome: "refused", reason: "an answer to that item is already queued" });
    expect(await press("a:e1:0")).toEqual({ toast: "an answer to that item is already queued" });
    expect(events.pressed).toEqual(["e1:0", "e1:0"]);
  });

  test("is refused with a short toast when it is unknown, belongs to no card, or its item is closed, and nothing runs", async () => {
    const events = fakeSource("event", "a");
    const { cards, link, press, db } = setup(undefined, [events]);
    events.open("e1");
    events.open("e2");
    await link();
    await cards.sync();
    events.close("e2", "Handled");

    expect((await press("zz:e1:0")).toast).toBe("that card is out of date");
    expect((await press("garbage")).toast).toBe("that card is out of date");
    expect((await press("a:nope:0")).toast).toBe("that card is out of date");
    expect((await press("a:e2:0")).toast).toBe("already handled");
    db.run("UPDATE channel_cards SET bot_id = 'other' WHERE item_id = 'e1'");
    expect((await press("a:e1:0")).toast).toBe("that card is out of date");
    expect(events.pressed).toEqual([]);
  });

  test("from an account that is not linked does nothing", async () => {
    const events = fakeSource("event", "a");
    const { cards, link, press } = setup(undefined, [events]);
    events.open("e1");
    await link();
    await cards.sync();
    expect(await press("a:e1:0", "m1", other)).toEqual({});
    expect(events.pressed).toEqual([]);
  });
});

describe("words", () => {
  test("a reply answers the card it replies to, even with several open", async () => {
    const events = fakeSource("event", "a");
    const waits = fakeSource("wait", "w");
    const { cards, link, say } = setup(undefined, [events, waits]);
    events.open("e1");
    waits.open("w1");
    await link();
    await cards.sync();

    expect(await say("use postgres", "m2")).toEqual({});
    expect(waits.replied).toEqual(["w1:use postgres"]);
    expect(events.replied).toEqual([]);
  });

  test("a reply to a card whose item is closed is told so and answers nothing", async () => {
    const events = fakeSource("event", "a");
    const { cards, link, say } = setup(undefined, [events]);
    events.open("e1");
    await link();
    await cards.sync();
    events.close("e1", "Handled");

    const reply = await say("too late", "m1");
    expect(reply.send?.[0]?.text).toContain("already handled");
    expect(events.replied).toEqual([]);
  });

  test("plain words answer the one open card, whatever its kind", async () => {
    const events = fakeSource("event", "a");
    const waits = fakeSource("wait", "w");
    const { cards, link, say } = setup(undefined, [events, waits]);
    events.open("e1");
    waits.open("w1");
    await link();
    await cards.sync();
    events.close("e1", "Handled");

    await say("hello");
    expect(waits.replied).toEqual(["w1:hello"]);
  });

  test("plain words with several open cards answer nothing and say to reply to a card", async () => {
    const events = fakeSource("event", "a");
    const { cards, link, say } = setup(undefined, [events]);
    events.open("e1");
    events.open("e2");
    await link();
    await cards.sync();

    const reply = await say("hello");
    expect(reply.send?.[0]?.text).toContain("Reply to the card");
    expect(events.replied).toEqual([]);
  });

  test("plain words with no open card do nothing at all", async () => {
    const events = fakeSource("event", "a");
    const { cards, link, say } = setup(undefined, [events]);
    events.open("e1");
    await link();
    await cards.sync();
    events.close("e1", "Handled");

    expect(await say("hello")).toEqual({});
    expect(events.replied).toEqual([]);
  });

  test("words that are queued or refused are answered with a message, and ones that closed the card are not", async () => {
    const events = fakeSource("event", "a");
    const { cards, link, say } = setup(undefined, [events]);
    events.open("e1");
    await link();
    await cards.sync();

    events.answerWith({ outcome: "queued" });
    expect((await say("hello")).send?.[0]?.text).toBe("queued; the bot is busy");
    events.answerWith({ outcome: "refused", reason: "that item is already handled" });
    expect((await say("hello")).send?.[0]?.text).toBe("that item is already handled");
    events.answerWith({ outcome: "answered" });
    expect(await say("hello")).toEqual({});
  });
});
