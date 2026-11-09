import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventAccess } from "@claudebot/contract/api";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ask-event-"));
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
const streams: AbortController[] = [];

interface Page {
  /** Every question the page was sent, replay included. */
  asks(): Ask[];
  /** The state each external row has on the page now. */
  rows(): Record<string, unknown>;
  /** The open-item count the page shows for a bot; 0 when the bot has none. */
  needsYou(botId: string): number;
  events(): PageEvent[];
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
const answer = (id: string, value: string) => host.ui("/api/answer", { id, value });
const dismiss = (botId: string, id: string) => host.ui("/api/bots/events/dismiss", { botId, id });

async function tokenOf(botId: string) {
  const res = await host.ui("/api/bots/events-token", { botId });
  return ((await res.json()) as EventAccess).token;
}

/** Posts a question event to a bot; the fake CLI receives it as the message of one turn. */
async function post(botId: string, key = "k1", title = "Which database?") {
  const res = await fetch(`${host.clientUrl}/api/bots/${botId}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await tokenOf(botId)}`,
    },
    body: JSON.stringify({
      kind: "question",
      key,
      source: { id: "auth-sso", label: "auth-sso" },
      title,
    }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { id: string }).id;
}

/** A bot with its chat open, a page watching and an open question event that has been delivered. */
async function setup(question = "Which database?") {
  const botId = host.createBot("Planner");
  await openBot(botId);
  const page = await watch();
  host.askOnMessage(question, ["Postgres", "SQLite"], { delivered: true });
  const eventId = await post(botId);
  await host.until(() => page.asks().length === 1);
  return { botId, page, eventId, ask: page.asks()[0]! };
}

describe("answering an ask_user raised for an external question", () => {
  test("a chip answer resolves the ask, closes its event on the page and in both counts, and a repeat changes nothing", async () => {
    const { botId, page, eventId, ask } = await setup();
    expect(ask.eventId).toBe(eventId);
    expect(page.rows()[eventId]).toBe("open");
    expect(page.needsYou(botId)).toBe(1);

    expect((await answer(ask.id, "Postgres")).status).toBe(200);
    await host.until(() => page.rows()[eventId] === "acted");
    await host.until(() => page.needsYou(botId) === 0);
    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()).toEqual(["Postgres"]);

    expect((await answer(ask.id, "SQLite")).status).toBe(404);
    await Bun.sleep(100);
    expect(host.toolResults()).toEqual(["Postgres"]);
    expect(page.rows()[eventId]).toBe("acted");
    expect(page.events().filter((e) => e.type === "answered")).toHaveLength(1);
  });

  test("a free-text answer closes the event too", async () => {
    const { botId, page, eventId, ask } = await setup();

    expect((await answer(ask.id, "use --safe")).status).toBe(200);
    await host.until(() => page.rows()[eventId] === "acted");
    await host.until(() => page.needsYou(botId) === 0);
    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()).toEqual(["use --safe"]);
  });

  test("two answers at once resolve the ask once and acknowledge once", async () => {
    const { page, eventId, ask } = await setup();

    const statuses = (await Promise.all([answer(ask.id, "Postgres"), answer(ask.id, "SQLite")]))
      .map((r) => r.status)
      .sort((a, b) => a - b);
    expect(statuses).toEqual([200, 404]);
    await host.until(() => page.rows()[eventId] === "acted");
    await host.until(() => host.toolResults().length === 1);
    await Bun.sleep(100);
    expect(host.toolResults()).toHaveLength(1);
  });

  test("a page that connects while the ask is pending is replayed its event, and one that connects after the answer sees it handled", async () => {
    const { page, eventId, ask } = await setup();

    const during = await watch();
    await host.until(() => during.asks().length === 1);
    expect(during.asks()[0]).toMatchObject({ id: ask.id, eventId });
    expect(during.rows()[eventId]).toBe("open");

    await answer(ask.id, "Postgres");
    await host.until(() => page.rows()[eventId] === "acted");
    const after = await watch();
    await host.until(() => after.asks().length === 1);
    expect(after.rows()[eventId]).toBe("acted");
    expect(after.events().some((e) => e.type === "answered")).toBe(true);
  });

  test("only the event the ask was raised for closes; an earlier open question stays", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const page = await watch();
    const first = await post(botId, "q1", "First?");
    await host.until(() => host.messagesOf(botId).length === 1);
    host.askOnMessage("Second?", ["Yes", "No"], { delivered: true });
    const second = await post(botId, "q2", "Second?");
    await host.until(() => page.asks().length === 1);
    expect(page.asks()[0]?.eventId).toBe(second);

    await answer(page.asks()[0]!.id, "Yes");
    await host.until(() => page.rows()[second] === "acted");
    expect(page.rows()[first]).toBe("open");
    expect(page.needsYou(botId)).toBe(1);
  });

  test("an ask the user answers after its event was dismissed still reaches the bot, and the event stays dismissed", async () => {
    const { botId, page, eventId, ask } = await setup();
    await dismiss(botId, eventId);
    await host.until(() => page.rows()[eventId] === "dismissed");

    expect((await answer(ask.id, "Postgres")).status).toBe(200);
    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()).toEqual(["Postgres"]);
    expect(page.rows()[eventId]).toBe("dismissed");
  });
});

describe("asks that are not about an external question", () => {
  test("an ordinary ask carries no event and answering it leaves an open question open", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const page = await watch();
    const eventId = await post(botId);
    await host.until(() => host.messagesOf(botId).length === 1);

    host.askOnMessage("Name?");
    expect((await host.ui("/api/send", { text: "go" })).status).toBe(200);
    await host.until(() => page.asks().length === 1);
    expect(page.asks()[0]).toMatchObject({ question: "Name?" });
    expect("eventId" in page.asks()[0]!).toBe(false);

    await answer(page.asks()[0]!.id, "Ada");
    await host.until(() => host.toolResults().length === 1);
    expect(host.toolResults()).toEqual(["Ada"]);
    expect(page.rows()[eventId]).toBe("open");
    expect(page.needsYou(botId)).toBe(1);
  });

  test("an ask for a question of another bot is not linked, and answering it leaves that bot's question open", async () => {
    const a = host.createBot("Planner");
    const b = host.createBot("Builder");
    await openBot(a);
    const page = await watch();
    const foreign = await post(b);
    await host.until(() => host.messagesOf(b).length === 1);

    host.askOnMessage("Which database?", ["Postgres"], { eventId: foreign });
    await host.ui("/api/send", { text: "go" });
    await host.until(() => page.asks().length === 1);
    expect("eventId" in page.asks()[0]!).toBe(false);

    await answer(page.asks()[0]!.id, "Postgres");
    await host.until(() => host.toolResults().length === 1);
    const other = await watch();
    await host.until(() => other.needsYou(b) === 1);
    expect(other.needsYou(a)).toBe(0);
  });

  test("an ask that names an event nobody posted is not linked", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const page = await watch();
    const real = await post(botId);
    await host.until(() => host.messagesOf(botId).length === 1);

    host.askOnMessage("Which database?", ["Postgres"], { eventId: "no-such-event" });
    await host.ui("/api/send", { text: "go" });
    await host.until(() => page.asks().length === 1);
    expect("eventId" in page.asks()[0]!).toBe(false);

    await answer(page.asks()[0]!.id, "Postgres");
    await host.until(() => host.toolResults().length === 1);
    expect(page.rows()[real]).toBe("open");
  });

  test("an ask that names an event already closed is not linked", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const page = await watch();
    const closed = await post(botId);
    await host.until(() => host.messagesOf(botId).length === 1);
    await dismiss(botId, closed);
    await host.until(() => page.rows()[closed] === "dismissed");

    host.askOnMessage("Which database?", ["Postgres"], { eventId: closed });
    await host.ui("/api/send", { text: "go" });
    await host.until(() => page.asks().length === 1);
    expect("eventId" in page.asks()[0]!).toBe(false);
    await answer(page.asks()[0]!.id, "Postgres");
    await host.until(() => host.toolResults().length === 1);
    expect(page.rows()[closed]).toBe("dismissed");
  });

  test("an ask that names an event still queued behind the running turn is not linked", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const page = await watch();
    host.hold();
    host.askOnMessage("Which database?", ["Postgres"], { afterHold: true });
    await host.ui("/api/send", { text: "first" });
    await host.until(() => host.messagesOf(botId).length === 1);

    // The event is stored and counted, but is only delivered once the held turn ends.
    const queued = await post(botId);
    host.askOnMessage("Which database?", ["Postgres"], { eventId: queued, afterHold: true });
    host.release();
    await host.until(() => page.asks().length === 1);
    expect("eventId" in page.asks()[0]!).toBe(false);

    host.stopAsking();
    await answer(page.asks()[0]!.id, "Postgres");
    await host.until(() => host.messagesOf(botId).length === 2);
    expect(page.rows()[queued]).toBe("open");
    expect(page.needsYou(botId)).toBe(1);
  });

  test("an ask in a new session cannot name an event from the old one", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const page = await watch();
    const old = await post(botId);
    await host.until(() => host.messagesOf(botId).length === 1);
    await host.until(() => page.events().some((e) => e.type === "done"));

    expect((await host.ui("/api/session/new", {})).status).toBe(200);
    host.askOnMessage("Which database?", ["Postgres"], { eventId: old });
    await host.ui("/api/send", { text: "go" });
    await host.until(() => page.asks().length === 1);
    expect("eventId" in page.asks()[0]!).toBe(false);

    await answer(page.asks()[0]!.id, "Postgres");
    await host.until(() => host.toolResults().length === 1);
    expect(page.rows()[old]).toBe("open");
  });
});

describe("a question that can no longer reach the bot", () => {
  test("when the turn dies the card is gone: answering it is refused and the event stays open", async () => {
    const botId = host.createBot("Planner");
    await openBot(botId);
    const page = await watch();
    host.askOnMessage("Which database?", ["Postgres"], { delivered: true, crash: true });
    const eventId = await post(botId);
    await host.until(() => page.asks().length === 1);
    await host.until(() => page.events().some((e) => e.type === "error"));
    expect(page.events()).toContainEqual({ type: "ask_expired", id: page.asks()[0]!.id });

    expect((await answer(page.asks()[0]!.id, "Postgres")).status).toBe(404);
    expect(page.rows()[eventId]).toBe("open");
    expect(page.needsYou(botId)).toBe(1);
  });

  test("after a host restart the old question is unknown and its event stays open", async () => {
    const { botId, eventId, ask } = await setup();

    await host.restart();
    expect((await answer(ask.id, "Postgres")).status).toBe(404);
    const page = await watch();
    await openBot(botId);
    await host.until(() => page.rows()[eventId] !== undefined || page.needsYou(botId) > 0);
    expect(page.needsYou(botId)).toBe(1);
  });
});
