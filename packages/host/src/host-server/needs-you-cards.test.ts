import { afterEach, describe, expect, test } from "bun:test";

import { ChannelLinkCodeResponse, type EventAccess } from "@claudebot/contract/api";

import { fakeTelegram, type FakeCall, type FakeTelegram } from "../testing/fake-telegram.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

const owner = { id: 4242, first_name: "Owner", last_name: "One" };
const hosts: HandoffHost[] = [];
const fakes: FakeTelegram[] = [];
const watches: EventsWatch[] = [];
afterEach(async () => {
  for (const w of watches.splice(0)) w.stop();
  for (const h of hosts.splice(0)) await h.stop();
  for (const f of fakes.splice(0)) await f.stop();
});

type Posted = {
  kind?: "question" | "blocked" | "failed" | "done" | "stopped";
  key?: string;
  title?: string;
  body?: string;
  options?: string[];
  resolves?: string[];
  /** Whether to wait for the bot's turn on the event to end; set to false for a bot that is held or waits on a question. */
  settle?: boolean;
};

type Keyboard = { text: string; callback_data?: string; url?: string }[][];

/** A host linked to a fake Telegram account, with helpers to post items, read the cards it sent and act on them as the owner. */
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

  /** The state an external event is stored in, whichever bot it belongs to: the page sees the rows of the bot it shows only. */
  const stateOf = (id: string) =>
    host.db
      .query<{ state: string }, [string]>("SELECT state FROM external_events WHERE id = ?")
      .get(id)?.state;
  const delivered = new Map<string, number>();
  /** The bot's status in the latest `bots` event the page saw. */
  const statusOf = (botId: string) => {
    const bots = page.events().filter((e) => e.type === "bots");
    const latest = bots.at(-1) as { bots: { id: string; status: string }[] } | undefined;
    return latest?.bots.find((b) => b.id === botId)?.status;
  };
  const post = async (botId: string, p: Posted = {}) => {
    const { token } = (await (
      await host.ui("/api/bots/events-token", { botId })
    ).json()) as EventAccess;
    const res = await fetch(`${host.clientUrl}/api/bots/${botId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: p.kind ?? "question",
        key: p.key ?? crypto.randomUUID(),
        source: { id: "auth-sso", label: "auth-sso" },
        title: p.title ?? "Which database?",
        ...(p.body !== undefined && { body: p.body }),
        ...(p.options !== undefined && { options: p.options }),
        ...(p.resolves !== undefined && { resolves: p.resolves }),
      }),
    });
    expect(res.status).toBe(202);
    const id = ((await res.json()) as { id: string }).id;
    const count = (delivered.get(botId) ?? 0) + 1;
    delivered.set(botId, count);
    // The bot's turn on the event is over, so an answer starts a turn instead of queueing behind it.
    if (p.settle !== false)
      await host.until(
        () => host.messagesOf(botId).length >= count && statusOf(botId) !== "working",
      );
    return id;
  };

  /** The messages the host sent that are cards: they carry a keyboard, which the link confirmation does not. */
  const cards = () =>
    tg.of("sendMessage").filter((c) => c.status === 200 && c.params.reply_markup !== undefined);
  const keyboard = (c: FakeCall): Keyboard => {
    // The request as the adapter sent it to the Bot API.
    const markup = c.params.reply_markup as { inline_keyboard: Keyboard };
    return markup.inline_keyboard;
  };
  const labels = (c: FakeCall) =>
    keyboard(c)
      .flat()
      .map((b) => b.text);
  const dataOf = (c: FakeCall, label: string) =>
    keyboard(c)
      .flat()
      .find((b) => b.text === label)!.callback_data!;
  /** The card of the nth item sent, once it is there. */
  const card = async (n: number) => {
    await host.until(() => cards().length > n);
    return cards()[n]!;
  };
  const edits = (c: FakeCall) =>
    tg.of("editMessageText").filter((e) => e.params.message_id === c.messageId);
  /** The toast of the latest button press that was answered. */
  const toast = () => String(tg.of("answerCallbackQuery").at(-1)?.params.text);
  /** Presses a button of a card by its data, and returns the toast the owner saw. */
  const pressData = async (c: FakeCall, data: string) => {
    const before = tg.of("answerCallbackQuery").length;
    await handled(tg.press(owner, data, c.messageId!));
    await host.until(() => tg.of("answerCallbackQuery").length > before);
    return toast();
  };
  const press = (c: FakeCall, label: string) => pressData(c, dataOf(c, label));
  const say = async (text: string, replyTo?: FakeCall) =>
    handled(tg.message(owner, text, replyTo ? { replyTo: replyTo.messageId! } : {}));

  return {
    tg,
    host,
    page,
    stateOf,
    link,
    post,
    cards,
    card,
    keyboard,
    labels,
    dataOf,
    edits,
    press,
    pressData,
    say,
  };
}

const openBot = (host: HandoffHost, botId: string) => host.ui("/api/open", { botId });
const OPTION = "auth-sso · Which database?: answer 'Postgres'";

describe("a card for an open item", () => {
  test("is sent once with its option buttons, Dismiss and no link on a loopback URL, and a restart sends nothing twice", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    await t.post(botId, { body: "SQL or not?", options: ["Postgres", "SQLite"] });

    const c = await t.card(0);
    expect(c.params.parse_mode).toBeUndefined();
    expect(c.params.text).toBe(
      "auth-sso · Which database?\n\nSQL or not?\n\nReply to this message to answer.",
    );
    expect(t.labels(c)).toEqual(["Postgres", "SQLite", "Dismiss"]);
    expect(
      t
        .keyboard(c)
        .flat()
        .filter((b) => b.url),
    ).toEqual([]);
    for (const b of t.keyboard(c).flat())
      expect(Buffer.byteLength(b.callback_data!)).toBeLessThanOrEqual(64);
    expect(c.params.chat_id).toBe(owner.id);

    await t.host.restart();
    await t.host.until(() => t.tg.of("getUpdates").length > 1);
    // The restart's own pass has run before this later item's, so a duplicate would be in front of it.
    await t.post(botId, { title: "Second?" });
    await t.card(1);
    expect(t.cards().map((x) => String(x.params.text).split("\n")[0])).toEqual([
      "auth-sso · Which database?",
      "auth-sso · Second?",
    ]);
  });

  test("with a public URL that is not loopback links to the bot's work panel", async () => {
    const t = await start(["--public-url", "https://claudebot.example.com"]);
    await t.link();
    const botId = t.host.createBot("Planner");
    await t.post(botId);
    const c = await t.card(0);
    expect(
      t
        .keyboard(c)
        .flat()
        .filter((b) => b.url),
    ).toEqual([
      { text: "Open in Claudebot", url: `https://claudebot.example.com/bots/${botId}?panel=work` },
    ]);
  });

  test("offers every kind the web UI's buttons, with a hint to reply when an action needs words", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    const kinds = ["blocked", "failed", "done", "stopped"] as const;
    for (const kind of kinds) await t.post(botId, { kind, title: kind });
    await t.post(botId, { title: "open question" });

    const expected = [
      ["Status", "Dismiss"],
      ["Retry", "Skip", "Dismiss"],
      ["Review", "Dismiss"],
      ["Status", "Dismiss"],
      ["Dismiss"],
    ];
    for (const [i, want] of expected.entries()) expect(t.labels(await t.card(i))).toEqual(want);
    const hints = t.cards().map((c) => String(c.params.text).includes("Reply to this message"));
    expect(hints).toEqual([true, false, false, false, true]);
  });

  test("is cut at about 3000 characters and shown as plain text", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    await t.post(botId, {
      kind: "done",
      title: "<b>done</b>",
      body: `<a href="x">y</a>${"x".repeat(8000)}`,
    });
    const text = String((await t.card(0)).params.text);
    expect(text.startsWith('auth-sso · <b>done</b>\n\n<a href="x">y</a>xxx')).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThan(3100);
  });

  test("is sent for items that arrived before the account was linked, oldest first, after the confirmation", async () => {
    const t = await start();
    const botId = t.host.createBot("Planner");
    await t.post(botId, { title: "first" });
    await t.post(botId, { title: "second" });
    expect(t.tg.outgoing()).toEqual([]);

    await t.link();
    await t.card(1);
    expect(t.tg.of("sendMessage").map((c) => String(c.params.text).split("\n")[0])).toEqual([
      expect.stringContaining("Linked"),
      "auth-sso · first",
      "auth-sso · second",
    ]);
  });

  test("that arrived while Telegram refused the bot is sent once it works again", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    t.tg.revoke();
    await t.post(botId, { title: "while down" });
    await t.host.until(() => t.tg.of("sendMessage").some((c) => !c.authorized));
    expect(t.cards()).toEqual([]);

    t.tg.allow(t.tg.token);
    await t.card(0);
    expect(String((await t.card(0)).params.text)).toStartWith("auth-sso · while down");
    expect(t.cards()).toHaveLength(1);
  });
});

describe("a button", () => {
  test("answers an idle bot like the web chip, closes the item and edits the card to Handled with no buttons", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    await openBot(t.host, botId);
    const id = await t.post(botId, { options: ["Postgres", "SQLite"] });
    const c = await t.card(0);
    expect(t.stateOf(id)).toBe("open");

    expect(await t.press(c, "Postgres")).toBe("Sent");
    await t.host.until(() => t.host.messagesOf(botId).includes(OPTION));
    await t.host.until(() => t.stateOf(id) === "acted");
    await t.host.until(() => t.edits(c).length === 1);
    expect(t.edits(c)[0]!.params.text).toBe("auth-sso · Which database?\n\nHandled");
    expect(t.keyboard(t.edits(c)[0]!)).toEqual([]);
    // The transcript and the counts follow as for any answer.
    expect(t.page.events().some((e) => e.type === "user" && e.text === OPTION)).toBe(true);
    await t.host.until(() => t.page.needsYou(botId) === 0);
  });

  test("a second press, and a press on a closed item, change nothing and the card is edited once", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    await t.post(botId, { options: ["Postgres", "SQLite"] });
    const c = await t.card(0);

    expect(await t.press(c, "Postgres")).toBe("Sent");
    expect(await t.press(c, "SQLite")).toContain("already handled");
    expect(await t.press(c, "Postgres")).toContain("already handled");
    await t.host.until(() => t.edits(c).length === 1);
    expect(t.host.messagesOf(botId).filter((m) => m.startsWith("auth-sso · Which"))).toEqual([
      OPTION,
    ]);
    expect(t.edits(c)).toHaveLength(1);
  });

  test("Retry sends its message with the item, and Dismiss closes the item as dismissed without a message", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    const failed = await t.post(botId, { kind: "failed", title: "deploy" });
    const noisy = await t.post(botId, { kind: "done", title: "built" });
    const [retry, review] = [await t.card(0), await t.card(1)];

    expect(await t.press(retry, "Retry")).toBe("Sent");
    await t.host.until(() => t.host.messagesOf(botId).includes("Retry auth-sso: deploy"));
    await t.host.until(() => t.stateOf(failed) === "acted");

    expect(await t.press(review, "Dismiss")).toBe("Dismissed");
    await t.host.until(() => t.stateOf(noisy) === "dismissed");
    await t.host.until(() => t.edits(review).length === 1);
    expect(t.edits(review)[0]!.params.text).toBe("auth-sso · built\n\nDismissed");
    expect(t.host.messagesOf(botId).some((m) => m.includes("Prepare the landing brief"))).toBe(
      false,
    );
  });

  test("answers a bot the page does not show", async () => {
    const t = await start();
    await t.link();
    const shown = t.host.createBot("Shown");
    const hidden = t.host.createBot("Hidden");
    await openBot(t.host, shown);
    await t.post(hidden, { options: ["Postgres"] });
    const c = await t.card(0);

    expect(t.host.server.currentBotId()).toBe(shown);
    expect(await t.press(c, "Postgres")).toBe("Sent");
    await t.host.until(() => t.host.messagesOf(hidden).includes(OPTION));
    expect(t.host.messagesOf(shown)).toEqual([]);
  });

  test("on a busy bot is queued, keeps its buttons, and the card is edited once the answer is delivered", async () => {
    const t = await start();
    await t.link();
    const hidden = t.host.createBot("Hidden");
    t.host.hold();
    const id = await t.post(hidden, { options: ["Postgres"], settle: false });
    const c = await t.card(0);
    await t.host.until(() => t.host.messagesOf(hidden).length === 1);

    expect(await t.press(c, "Postgres")).toBe("queued; the bot is busy");
    expect(t.stateOf(id)).toBe("open");
    expect(t.edits(c)).toEqual([]);
    // Pressing again is refused, not queued twice.
    expect(await t.press(c, "Postgres")).toContain("already queued");

    t.host.release();
    await t.host.until(() => t.host.messagesOf(hidden).includes(OPTION));
    await t.host.until(() => t.edits(c).length === 1);
    expect(t.stateOf(id)).toBe("acted");
  });

  test("answers the bot's pending question about the item, and no chat message is created", async () => {
    const t = await start();
    await t.link();
    const hidden = t.host.createBot("Hidden");
    await openBot(t.host, hidden);
    t.host.askOnMessage("Which database?", ["Postgres", "SQLite"], { delivered: true });
    const id = await t.post(hidden, { options: ["Postgres", "SQLite"], settle: false });
    const c = await t.card(0);
    await t.host.until(() => t.page.events().some((e) => e.type === "ask"));

    expect(await t.press(c, "Postgres")).toBe("Answered");
    await t.host.until(() => t.host.toolResults().length === 1);
    expect(t.host.toolResults()).toEqual(["Postgres"]);
    await t.host.until(() => t.stateOf(id) === "acted");
    await t.host.until(() => t.edits(c).length === 1);
    expect(t.host.messagesOf(hidden)).toHaveLength(1);
    expect(t.page.events().some((e) => e.type === "user")).toBe(false);
  });

  test("with an index the item does not have, for a draft action, or for an unknown item is refused", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    const id = await t.post(botId, { options: ["Postgres"] });
    const c = await t.card(0);
    const press = (data: string) => t.pressData(c, data);

    expect(await press(`a:${id}:9`)).toContain("out of date");
    // Index 1 is `Other…`, a draft: it has no button, so a press naming it is refused too.
    expect(await press(`a:${id}:1`)).toContain("out of date");
    expect(await press(`a:${id}:x`)).toContain("out of date");
    expect(await press("a:no-such-item:0")).toContain("out of date");
    expect(await press("zzz")).toContain("out of date");
    expect(t.host.messagesOf(botId).filter((m) => m.includes("answer '"))).toEqual([]);
    expect(t.stateOf(id)).toBe("open");
  });
});

describe("a card whose item closes elsewhere", () => {
  test("is edited to Dismissed, Handled or Resolved by its source, once each, and loses its buttons", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    await openBot(t.host, botId);
    const dismissed = await t.post(botId, { title: "one" });
    const answered = await t.post(botId, { title: "two" });
    const resolved = await t.post(botId, { kind: "failed", key: "k3", title: "three" });
    const [one, two, three] = [await t.card(0), await t.card(1), await t.card(2)];

    expect((await t.host.ui("/api/bots/events/dismiss", { botId, id: dismissed })).status).toBe(
      200,
    );
    expect(
      (
        await t.host.ui("/api/send", {
          text: "auth-sso · two: yes",
          eventId: answered,
          answer: "yes",
        })
      ).status,
    ).toBe(200);
    await t.post(botId, { kind: "done", title: "ok", resolves: ["k3"] });
    await t.card(3);

    await t.host.until(() => [one, two, three].every((c) => t.edits(c).length === 1));
    const outcomes = [one, two, three].map(
      (c) => String(t.edits(c)[0]!.params.text).split("\n\n")[1],
    );
    expect(outcomes).toEqual(["Dismissed", "Handled", "Resolved by its source"]);
    for (const c of [one, two, three]) expect(t.keyboard(t.edits(c)[0]!)).toEqual([]);
    // Pressing a button of an edited card is refused, and it is not edited again.
    expect(await t.pressData(three, `a:${resolved}:d`)).toContain("already handled");
    expect(t.edits(three)).toHaveLength(1);
  });
});

describe("words", () => {
  test("a reply answers the card it replies to, with the reply as the answer, while others stay open", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    const first = await t.post(botId, { title: "first" });
    const second = await t.post(botId, { title: "second" });
    const [a, b] = [await t.card(0), await t.card(1)];

    await t.say("use sqlite", b);
    await t.host.until(() => t.host.messagesOf(botId).includes("auth-sso · second: use sqlite"));
    await t.host.until(() => t.stateOf(second) === "acted");
    await t.host.until(() => t.edits(b).length === 1);
    expect(t.stateOf(first)).toBe("open");
    expect(t.edits(a)).toEqual([]);
  });

  test("a plain message answers the one open card", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    const only = await t.post(botId);
    const c = await t.card(0);

    await t.say("Postgres, obviously");
    await t.host.until(() =>
      t.host.messagesOf(botId).includes("auth-sso · Which database?: Postgres, obviously"),
    );
    await t.host.until(() => t.stateOf(only) === "acted");
    await t.host.until(() => t.edits(c).length === 1);
  });

  test("a plain message with several open cards answers nothing and says to reply to the card", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    const ids = [await t.post(botId, { title: "a" }), await t.post(botId, { title: "b" })];
    await t.card(1);
    await t.host.until(() => ids.every((id) => t.stateOf(id) === "open"));
    const before = t.host.messagesOf(botId).length;

    await t.say("hello");
    await t.host.until(() => t.tg.texts().some((x) => x.includes("Reply to the card")));
    expect(t.host.messagesOf(botId)).toHaveLength(before);
    expect(ids.map((id) => t.stateOf(id))).toEqual(["open", "open"]);
  });

  test("a plain message with no open card reaches no bot, run or chat", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    await openBot(t.host, botId);
    const outgoing = t.tg.outgoing().length;
    const before = t.host.messagesOf(botId).length;

    await t.say("hello?");
    await t.say("anyone there");
    expect(t.tg.outgoing()).toHaveLength(outgoing);
    expect(t.host.messagesOf(botId)).toHaveLength(before);
    expect(t.page.events().some((e) => e.type === "user")).toBe(false);
  });

  test("a message from an account that is not linked answers nothing", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    const id = await t.post(botId);
    const c = await t.card(0);
    const stranger = { id: 999, first_name: "Stranger" };
    const sent = t.tg.outgoing().length;

    await t.host.until(() => t.stateOf(id) === "open");
    const a = t.tg.message(stranger, "yes", { replyTo: c.messageId! });
    const b = t.tg.press(stranger, t.dataOf(c, "Dismiss"), c.messageId!);
    await t.host.until(() =>
      t.tg
        .of("getUpdates")
        .some((u) => typeof u.params.offset === "number" && u.params.offset > Math.max(a, b)),
    );
    expect(t.tg.outgoing()).toHaveLength(sent);
    expect(t.stateOf(id)).toBe("open");
  });
});

describe("the web route and a button", () => {
  type Scenario = {
    name: string;
    prepare(host: HandoffHost): void;
    /** What `/api/send` answers for the item, and so what the button must too. */
    outcome: "sent" | "queued" | "answered";
  };
  const scenarios: Scenario[] = [
    { name: "an idle bot", prepare: () => {}, outcome: "sent" },
    { name: "a busy bot", prepare: (host) => host.hold(), outcome: "queued" },
    {
      name: "a bot with a pending question about the item",
      prepare: (host) =>
        host.askOnMessage("Which database?", ["Postgres", "SQLite"], { delivered: true }),
      outcome: "answered",
    },
  ];
  const toasts = { sent: "Sent", queued: "queued; the bot is busy", answered: "Answered" };

  for (const s of scenarios) {
    test(`give the same outcome for ${s.name}`, async () => {
      const t = await start();
      await t.link();
      s.prepare(t.host);
      /** A bot the page shows, with one open question in the scenario's state. */
      const shownBotWithItem = async (name: string) => {
        const botId = t.host.createBot(name);
        await openBot(t.host, botId);
        const asks = t.page.events().filter((e) => e.type === "ask").length;
        const id = await t.post(botId, {
          options: ["Postgres", "SQLite"],
          settle: s.outcome === "sent",
        });
        if (s.outcome === "queued") await t.host.until(() => t.host.messagesOf(botId).length === 1);
        if (s.outcome === "answered")
          await t.host.until(() => t.page.events().filter((e) => e.type === "ask").length > asks);
        return id;
      };

      const webItem = await shownBotWithItem("Web");
      const web = await t.host.ui("/api/send", {
        text: OPTION,
        eventId: webItem,
        answer: "Postgres",
      });
      expect(web.status).toBe(200);
      const outcome = ((await web.json()) as { outcome: string }).outcome;
      expect(outcome).toBe(s.outcome);

      await shownBotWithItem("Telegram");
      expect(await t.press(await t.card(1), "Postgres")).toBe(
        toasts[outcome as keyof typeof toasts],
      );
    });
  }

  test("both refuse an item that was handled already", async () => {
    const t = await start();
    await t.link();
    const botId = t.host.createBot("Planner");
    await openBot(t.host, botId);
    const id = await t.post(botId, { options: ["Postgres"] });
    const c = await t.card(0);
    expect(await t.press(c, "Postgres")).toBe("Sent");
    await t.host.until(() => t.stateOf(id) === "acted");

    const web = await t.host.ui("/api/send", { text: OPTION, eventId: id, answer: "Postgres" });
    expect(web.status).toBe(409);
    expect(((await web.json()) as { error: string }).error).toContain("already handled");
    expect(await t.press(c, "Postgres")).toContain("already handled");
  });
});
