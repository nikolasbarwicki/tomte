import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventAccess } from "@tomte/contract/api";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;
const streams: AbortController[] = [];

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "answers-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost(["--data-root", join(scratch, "state")]);
});
afterEach(async () => {
  streams.splice(0).forEach((s) => s.abort());
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

type PageEvent = { type: string; [k: string]: unknown };

interface Page {
  /** The sidebar badge: a bot's open-item count in the newest bots slice. */
  badge(botId: string): number | undefined;
  /** The state of an external row in the open chat's transcript, after every later change. */
  row(id: string): unknown;
  /** How many events of this type the page has seen. */
  count(type: string): number;
}

/** One page's `/api/events` stream from now on, as the sidebar and the transcript read it. */
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
        for (const p of parts) if (p.startsWith("data: ")) seen.push(...eventsOf(p.slice(6)));
      }
    } catch {
      // The test ended the stream.
    }
  })();
  return {
    badge(botId): number | undefined {
      const slice = seen.filter((e) => e.type === "bots").at(-1) as
        | (PageEvent & { bots: { id: string; needsYou: number }[] })
        | undefined;
      return slice?.bots.find((b) => b.id === botId)?.needsYou;
    },
    row(id) {
      let state: unknown;
      for (const e of seen) {
        if (e.id !== id) continue;
        if (e.type === "external" || e.type === "external_state") state = e.state;
      }
      return state;
    },
    count: (type: string) => seen.filter((e) => e.type === type).length,
  };
}

/** The JSON body of a response, typed by the test that knows the route. */
const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const stateOf = (id: string) => {
  const db = new Database(join(host.dataRoot, "tomte.db"), { readonly: true });
  try {
    return db
      .query<{ state: string }, [string]>("SELECT state FROM external_events WHERE id = ?")
      .get(id)?.state;
  } finally {
    db.close();
  }
};

/** A bot with an open question that reached it, and a page that saw the whole turn end, so the bot is idle. */
async function askedBot(name = "Planner", key = "q1") {
  const botId = host.createBot(name);
  const { token } = await bodyOf<EventAccess>(await host.ui("/api/bots/events-token", { botId }));
  const res = await fetch(`${host.clientUrl}/api/bots/${botId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      kind: "question",
      key,
      source: { id: "auth-sso", label: "auth-sso" },
      title: "Which database?",
    }),
  });
  expect(res.status).toBe(202);
  const { id } = await bodyOf<{ id: string }>(res);
  return { botId, token, id };
}

const open = (botId: string) => host.ui("/api/open", { botId });
const send = (text: string, eventId?: string) =>
  host.ui("/api/send", { text, ...(eventId !== undefined && { eventId }) });
const answers = (botId: string, text: string) =>
  host.messagesOf(botId).filter((m) => m === text).length;

/** Opens the bot and waits until the question's delivery turn is over. */
async function idleWith(botId: string, id: string): Promise<Page> {
  await open(botId);
  const page = await watch();
  await host.until(() => host.messagesOf(botId).length === 1 && page.count("done") >= 1);
  await host.until(() => page.row(id) === "open");
  return page;
}

describe("a free-text answer to a needs-you item", () => {
  test("sent to an idle bot, it reaches the bot and closes the item, its row and both badges", async () => {
    const { botId, id } = await askedBot();
    const page = await idleWith(botId, id);
    expect(page.badge(botId)).toBe(1);

    const res = await send("DB, encrypted", id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "sent" });

    await host.until(() => page.row(id) === "acted");
    await host.until(() => page.badge(botId) === 0);
    expect(stateOf(id)).toBe("acted");
    expect(answers(botId, "DB, encrypted")).toBe(1);
  });

  test("sent to a busy bot, it is queued and the item stays open until it is delivered", async () => {
    const { botId, id } = await askedBot();
    const page = await idleWith(botId, id);
    host.hold();
    expect((await send("working")).status).toBe(200);
    await host.until(() => host.messagesOf(botId).length === 2);

    const queued = await bodyOf<{ outcome?: string; queued?: string }>(await send("DB, plain", id));
    expect(queued.outcome).toBe("queued");
    expect(queued.queued).toBeString();
    await host.until(() => page.count("queued") === 1);
    expect(stateOf(id)).toBe("open");
    expect(page.row(id)).toBe("open");
    expect(page.badge(botId)).toBe(1);

    host.release();
    await host.until(() => page.row(id) === "acted");
    await host.until(() => page.badge(botId) === 0);
    await host.until(() => answers(botId, "DB, plain") === 1);
    expect(stateOf(id)).toBe("acted");
  });

  test("a second answer for an item whose first is still queued is refused, not queued twice", async () => {
    const { botId, id } = await askedBot();
    const page = await idleWith(botId, id);
    host.hold();
    await send("working");
    await host.until(() => host.messagesOf(botId).length === 2);
    expect((await send("first", id)).status).toBe(200);

    const again = await send("second", id);
    expect(again.status).toBe(409);
    expect((await bodyOf<{ error: string }>(again)).error).toContain("already queued");
    expect(page.count("queued")).toBe(1);

    host.release();
    await host.until(() => page.row(id) === "acted");
    await host.until(() => host.messagesOf(botId).length === 3);
    expect(answers(botId, "first")).toBe(1);
    expect(answers(botId, "second")).toBe(0);
  });

  test("cancelling the queued answer never closes the item, and the item can still be answered", async () => {
    const { botId, id } = await askedBot();
    const page = await idleWith(botId, id);
    host.hold();
    await send("working");
    await host.until(() => host.messagesOf(botId).length === 2);
    const { queued } = await bodyOf<{ queued: string }>(await send("never mind", id));

    expect((await host.ui("/api/send/cancel", { id: queued })).status).toBe(200);
    host.release();
    await host.until(() => page.count("done") >= 2);
    expect(stateOf(id)).toBe("open");
    expect(page.row(id)).toBe("open");
    expect(page.badge(botId)).toBe(1);
    expect(answers(botId, "never mind")).toBe(0);

    expect((await send("DB, encrypted", id)).status).toBe(200);
    await host.until(() => page.row(id) === "acted");
  });

  test("a repeated send, or one for an item already handled elsewhere, is refused and delivers nothing", async () => {
    const { botId, id } = await askedBot();
    const page = await idleWith(botId, id);
    expect((await send("DB, encrypted", id)).status).toBe(200);
    await host.until(() => page.row(id) === "acted");
    await host.until(() => page.count("done") >= 2);

    const repeat = await send("DB, encrypted", id);
    expect(repeat.status).toBe(409);
    expect((await bodyOf<{ error: string }>(repeat)).error).toContain("already handled");
    expect(answers(botId, "DB, encrypted")).toBe(1);

    const other = await askedBot("Builder", "q2");
    await open(other.botId);
    await host.until(() => host.messagesOf(other.botId).length === 1);
    expect(
      (await host.ui("/api/bots/events/dismiss", { botId: other.botId, id: other.id })).status,
    ).toBe(200);
    expect((await send("too late", other.id)).status).toBe(409);
    expect(host.messagesOf(other.botId)).toHaveLength(1);
  });

  test("an id the open bot does not have open is refused: another bot's item, a stale id, a progress event", async () => {
    const mine = await askedBot("Planner", "q1");
    const theirs = await askedBot("Builder", "q1");
    const page = await idleWith(mine.botId, mine.id);
    const progress = await fetch(`${host.clientUrl}/api/bots/${mine.botId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${mine.token}` },
      body: JSON.stringify({
        kind: "progress",
        key: "p1",
        source: { id: "auth-sso", label: "auth-sso" },
        title: "p",
      }),
    });
    const { id: info } = await bodyOf<{ id: string }>(progress);

    for (const eventId of [theirs.id, "no-such-event", info]) {
      expect((await send("hello", eventId)).status).toBe(409);
    }
    expect((await send("hello", "")).status).toBe(400);
    expect(host.messagesOf(mine.botId)).toHaveLength(1);
    expect(stateOf(theirs.id)).toBe("open");
    expect(stateOf(mine.id)).toBe("open");
    expect(page.badge(mine.botId)).toBe(1);
  });

  test("an ordinary message never closes an item, queued or not", async () => {
    const { botId, id } = await askedBot();
    const page = await idleWith(botId, id);
    expect((await send("DB, encrypted")).status).toBe(200);
    await host.until(() => page.count("done") >= 2);
    host.hold();
    await send("working");
    await host.until(() => host.messagesOf(botId).length === 3);
    expect((await bodyOf<{ queued?: string }>(await send("also this"))).queued).toBeString();
    host.release();
    await host.until(() => host.messagesOf(botId).length === 4);
    await host.until(() => page.count("done") >= 4);

    expect(stateOf(id)).toBe("open");
    expect(page.row(id)).toBe("open");
    expect(page.badge(botId)).toBe(1);
  });
});
