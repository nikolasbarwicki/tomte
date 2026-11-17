import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventAccess } from "@tomte/contract/api";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;
const streams: AbortController[] = [];

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "needs-you-answers-"));
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
type Ask = { id: string; question: string; options?: string[]; eventId?: string };

interface Page {
  asks(): Ask[];
  rows(): Record<string, unknown>;
  needsYou(botId: string): number;
  events(): PageEvent[];
  count(type: string): number;
}

/** One page's `/api/events` stream from now on: what it was replayed on connecting, then what the host broadcasts. */
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
        for (const p of parts) if (p.startsWith("data: ")) seen.push(JSON.parse(p.slice(6)));
      }
    } catch {
      // The test ended the stream.
    }
  })();
  return {
    events: () => seen,
    count: (type) => seen.filter((e) => e.type === type).length,
    asks: () => seen.filter((e) => e.type === "ask") as unknown as Ask[],
    rows() {
      const states = new Map<string, unknown>();
      for (const e of seen) {
        if (e.type === "external") states.set(e.id as string, e.state);
        if (e.type === "external_state" && states.has(e.id as string))
          states.set(e.id as string, e.state);
      }
      return Object.fromEntries(states);
    },
    needsYou(botId) {
      const latest = seen.filter((e) => e.type === "bots").at(-1) as
        | (PageEvent & { bots: { id: string; needsYou: number }[] })
        | undefined;
      return latest?.bots.find((b) => b.id === botId)?.needsYou ?? 0;
    },
  };
}

const openBot = (botId: string) => host.ui("/api/open", { botId });
const dismiss = (botId: string, id: string) => host.ui("/api/bots/events/dismiss", { botId, id });
/** What a Needs-you chip or the composer sends for an item: a message that carries its id, and for a chip the option the question is answered with. */
const sendAnswer = (text: string, eventId: string, answer?: string) =>
  host.ui("/api/send", { text, eventId, ...(answer !== undefined && { answer }) });
const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function post(botId: string, key = "k1", title = "Which database?") {
  const { token } = await body<EventAccess>(await host.ui("/api/bots/events-token", { botId }));
  const res = await fetch(`${host.clientUrl}/api/bots/${botId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      kind: "question",
      key,
      source: { id: "auth-sso", label: "auth-sso" },
      title,
    }),
  });
  expect(res.status).toBe(202);
  return (await body<{ id: string }>(res)).id;
}

/** A bot whose turn is running with a linked question pending for an open event, and a page that saw it. */
async function pendingAsk() {
  const botId = host.createBot("Planner");
  await openBot(botId);
  const page = await watch();
  host.askOnMessage("Which database?", ["Postgres", "SQLite"], { delivered: true });
  const eventId = await post(botId);
  await host.until(() => page.asks().length === 1);
  return { botId, page, eventId, ask: page.asks()[0]! };
}

describe("answering a needs-you item whose bot is waiting on a question about it", () => {
  test("a chip resolves the question with its option, creates no chat message, and only then closes the item", async () => {
    const { botId, page, eventId, ask } = await pendingAsk();
    expect(ask.eventId).toBe(eventId);
    // Nothing has been answered yet: the item is open and nothing reached the question.
    expect(page.rows()[eventId]).toBe("open");
    expect(host.toolResults()).toEqual([]);

    const res = await sendAnswer(
      "auth-sso · Which database?: answer 'Postgres'",
      eventId,
      "Postgres",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "answered" });

    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()).toEqual(["Postgres"]);
    await host.until(() => page.rows()[eventId] === "acted");
    await host.until(() => page.needsYou(botId) === 0);
    // The answer is the question's, not a second message to the bot.
    expect(host.messagesOf(botId)).toHaveLength(1);
    expect(page.count("queued")).toBe(0);
    expect(page.count("user")).toBe(0);
    expect(page.events().filter((e) => e.type === "answered")).toEqual([
      { type: "answered", id: ask.id, value: "Postgres" },
    ]);
  });

  test("free text from the composer resolves the question with the text", async () => {
    const { botId, page, eventId } = await pendingAsk();

    const res = await sendAnswer("auth-sso · Which database?: use --safe", eventId);
    expect(await res.json()).toEqual({ ok: true, outcome: "answered" });
    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()).toEqual(["auth-sso · Which database?: use --safe"]);
    await host.until(() => page.rows()[eventId] === "acted");
    expect(host.messagesOf(botId)).toHaveLength(1);
    expect(page.count("queued")).toBe(0);
  });

  test("an ordinary message meanwhile queues and does not close the item or answer the question", async () => {
    const { botId, page, eventId } = await pendingAsk();

    const ordinary = await body<{ outcome: string }>(await host.ui("/api/send", { text: "btw" }));
    expect(ordinary.outcome).toBe("queued");
    await Bun.sleep(100);
    expect(page.rows()[eventId]).toBe("open");
    expect(host.toolResults()).toEqual([]);

    await sendAnswer("x", eventId, "SQLite");
    await host.until(() => host.toolResults().length === 1);
    // The ordinary message still goes out after the turn, once.
    await host.until(() => host.messagesOf(botId).filter((m) => m === "btw").length === 1);
    expect(host.toolResults()).toEqual(["SQLite"]);
  });

  test("two devices answering at once: one resolves the question, the other is told the item is handled", async () => {
    const { page, eventId } = await pendingAsk();

    const results = await Promise.all([
      sendAnswer("a", eventId, "Postgres"),
      sendAnswer("b", eventId, "SQLite"),
    ]);
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 409]);
    const refused = results.find((r) => r.status === 409)!;
    expect((await body<{ error: string }>(refused)).error).toContain("already handled");

    await host.until(() => page.rows()[eventId] === "acted");
    await host.until(() => host.toolResults().length === 1);
    await Bun.sleep(100);
    expect(host.toolResults()).toHaveLength(1);
    expect(page.count("answered")).toBe(1);
    expect(page.count("queued")).toBe(0);
  });

  test("a chip racing the card's own answer resolves the question once", async () => {
    const { page, eventId, ask } = await pendingAsk();

    const results = await Promise.all([
      sendAnswer("a", eventId, "Postgres"),
      host.ui("/api/answer", { id: ask.id, value: "SQLite" }),
    ]);
    // Whichever came second finds the question resolved: the chip is told the item is handled, the card that there is no such question.
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 || r.status === 404)).toHaveLength(1);
    await host.until(() => page.rows()[eventId] === "acted");
    await host.until(() => host.toolResults().length === 1);
    await Bun.sleep(100);
    expect(host.toolResults()).toHaveLength(1);
    expect(page.count("answered")).toBe(1);
  });

  test("an answer for another bot's item is refused and the pending question stays answerable", async () => {
    const { page, eventId, ask } = await pendingAsk();
    const other = host.createBot("Builder");
    const foreign = await post(other, "q1", "Other?");

    const refused = await sendAnswer("x", foreign, "Postgres");
    expect(refused.status).toBe(409);
    expect((await sendAnswer("x", "no-such-event", "Postgres")).status).toBe(409);
    await Bun.sleep(100);
    expect(host.toolResults()).toEqual([]);
    expect(page.rows()[eventId]).toBe("open");

    expect((await host.ui("/api/answer", { id: ask.id, value: "Postgres" })).status).toBe(200);
    await host.until(() => page.rows()[eventId] === "acted");
  });

  test("a dismissed item is refused, leaving the question for its card to answer", async () => {
    const { botId, page, eventId, ask } = await pendingAsk();
    await dismiss(botId, eventId);
    await host.until(() => page.rows()[eventId] === "dismissed");

    expect((await sendAnswer("x", eventId, "Postgres")).status).toBe(409);
    expect(host.toolResults()).toEqual([]);
    expect((await host.ui("/api/answer", { id: ask.id, value: "Postgres" })).status).toBe(200);
    await host.until(() => host.toolResults().length === 1);
    expect(page.rows()[eventId]).toBe("dismissed");
  });

  test("an answer queued before the question existed is cancelled once the question is answered, so the bot hears it once", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const page = await watch();
    host.hold();
    host.askOnMessage("Which database?", ["Postgres"], { delivered: true, afterHold: true });
    const eventId = await post(botId);
    await host.until(() => host.messagesOf(botId).length === 1);

    // The turn that carries the event is still running and has not asked: the answer waits in the queue.
    const queued = await body<{ outcome: string; queued: string }>(
      await sendAnswer("typed answer", eventId),
    );
    expect(queued.outcome).toBe("queued");
    expect(page.rows()[eventId]).toBe("open");

    host.release();
    await host.until(() => page.asks().length === 1);
    expect(page.asks()[0]?.eventId).toBe(eventId);
    expect(page.rows()[eventId]).toBe("open");

    expect((await sendAnswer("chip", eventId, "Postgres")).status).toBe(200);
    await host.until(() => page.rows()[eventId] === "acted");
    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()).toEqual(["Postgres"]);
    expect(page.events().some((e) => e.type === "dequeued" && e.id === queued.queued)).toBe(true);
    await host.until(() => page.count("done") >= 1);
    await Bun.sleep(150);
    expect(host.messagesOf(botId).filter((m) => m === "typed answer")).toEqual([]);
    expect((await host.ui("/api/send/cancel", { id: queued.queued })).status).toBe(404);
  });
});

describe("a question whose turn ended", () => {
  test("its card is marked expired, and an answer to the item goes to the bot as a message that closes it", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const page = await watch();
    host.askOnMessage("Which database?", ["Postgres"], { delivered: true, crash: true });
    const eventId = await post(botId);
    await host.until(() => page.asks().length === 1);
    const ask = page.asks()[0]!;
    await host.until(() => page.events().some((e) => e.type === "ask_expired" && e.id === ask.id));

    expect((await host.ui("/api/answer", { id: ask.id, value: "Postgres" })).status).toBe(404);
    expect(page.rows()[eventId]).toBe("open");
    expect(page.needsYou(botId)).toBe(1);

    host.stopAsking();
    const res = await sendAnswer("auth-sso · Which database?: Postgres", eventId, "Postgres");
    expect(await res.json()).toEqual({ ok: true, outcome: "sent" });
    await host.until(() => page.rows()[eventId] === "acted");
    await host.until(() =>
      host.messagesOf(botId).some((m) => m === "auth-sso · Which database?: Postgres"),
    );
  });

  test("a page that connects later is replayed the expired card", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const first = await watch();
    host.askOnMessage("Which database?", ["Postgres"], { delivered: true, crash: true });
    await post(botId);
    await host.until(() => first.count("ask_expired") === 1);

    const later = await watch();
    await host.until(() => later.count("ask_expired") === 1);
    expect(later.asks()).toHaveLength(1);
  });
});

describe("answering with no question pending", () => {
  test("an idle bot is sent the message and the item closes: outcome sent", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const page = await watch();
    const eventId = await post(botId);
    await host.until(() => page.count("done") >= 1);

    const res = await sendAnswer("auth-sso · Which database?: Postgres", eventId, "Postgres");
    expect(await res.json()).toEqual({ ok: true, outcome: "sent" });
    await host.until(() => page.rows()[eventId] === "acted");
    expect(host.messagesOf(botId)).toContain("auth-sso · Which database?: Postgres");
  });

  test("a busy bot queues it and the item stays open until it is delivered: outcome queued", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const page = await watch();
    const eventId = await post(botId);
    await host.until(() => page.count("done") >= 1);
    host.hold();
    await host.ui("/api/send", { text: "working" });
    await host.until(() => host.messagesOf(botId).includes("working"));

    const res = await body<{ outcome: string }>(await sendAnswer("Postgres please", eventId));
    expect(res.outcome).toBe("queued");
    await Bun.sleep(100);
    expect(page.rows()[eventId]).toBe("open");
    expect(page.needsYou(botId)).toBe(1);

    host.release();
    await host.until(() => page.rows()[eventId] === "acted");
    await host.until(() => host.messagesOf(botId).includes("Postgres please"));
  });
});
