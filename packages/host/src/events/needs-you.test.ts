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
  scratch = mkdtempSync(join(tmpdir(), "needs-you-"));
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
type WorkView = {
  type: "work";
  botId: string;
  sources: {
    id: string;
    status: string;
    events: { id: string; kind: string; key?: string; title: string; state: string }[];
  }[];
};

const streams: AbortController[] = [];

interface Page {
  /** The newest work event the page received for a bot. */
  work(botId: string): (WorkView & PageEvent) | undefined;
  /** The latest bots slice the page received: each bot's open-item count, the sources behind it, when the newest arrived and its status. */
  bots(): Record<
    string,
    { needsYou: number; needsYouSources: string[]; needsYouAt: number; status: string }
  >;
  /** The state each external row has on the page now: its row, then every later state change. */
  rows(): Record<string, unknown>;
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
    work: (botId) =>
      seen.filter((e): e is WorkView & PageEvent => e.type === "work" && e.botId === botId).at(-1),
    bots() {
      const latest = seen.filter((e) => e.type === "bots").at(-1) as
        | (PageEvent & { bots: ({ id: string } & ReturnType<Page["bots"]>[string])[] })
        | undefined;
      return Object.fromEntries(latest?.bots.map(({ id, ...rest }) => [id, rest]) ?? []);
    },
    rows() {
      const states = new Map<string, unknown>();
      for (const e of seen) {
        if (e.type === "external") states.set(e.id as string, e.state);
        if (e.type === "external_state" && states.has(e.id as string))
          states.set(e.id as string, e.state);
      }
      return Object.fromEntries(states);
    },
  };
}

const openBot = (botId: string) => host.ui("/api/open", { botId });

async function tokenOf(botId: string) {
  const res = await host.ui("/api/bots/events-token", { botId });
  return ((await res.json()) as EventAccess).token;
}

async function post(botId: string, token: string, over: Record<string, unknown>) {
  const res = await fetch(`${host.clientUrl}/api/bots/${botId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      kind: "question",
      key: "k1",
      source: { id: "auth-sso", label: "auth-sso" },
      title: "Which database?",
      ...over,
    }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { id: string }).id;
}

/** Answers an item the way the page does, with a message that carries its id to the bot's open chat; resolves to the status. */
const act = async (botId: string, id: string) => {
  await openBot(botId);
  for (;;) {
    const res = await host.ui("/api/send", { text: "ok", eventId: id });
    const body = (await res.json()) as { outcome?: string; queued?: string };
    if (body.outcome !== "queued") return res.status;
    // The bot is still on an earlier turn; an item is only closed once its answer is delivered, so take the answer back and ask
    // again when the bot is free. If the turn ended first, the queued answer already reached the bot and closed the item.
    if ((await host.ui("/api/send/cancel", { id: body.queued })).status === 404) return res.status;
    await Bun.sleep(25);
  }
};
const dismiss = (botId: string, id: string) => host.ui("/api/bots/events/dismiss", { botId, id });

/** The state of each event of a page's work event, by event id. */
const statesOf = (page: Page, botId: string) =>
  Object.fromEntries(
    page.work(botId)?.sources.flatMap((s) => s.events.map((e) => [e.id, e.state])) ?? [],
  );

describe("answering and dismissing a needs-you item", () => {
  test("an answer closes the item on the stream and in the row already in the transcript, and a repeat changes nothing", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await openBot(a);
    const page = await watch();
    const id = await post(a, token, { options: ["DB, encrypted", "DB, plain"] });
    await host.until(() => page.rows()[id] === "open");
    expect(statesOf(page, a)[id]).toBe("open");

    expect(await act(a, id)).toBe(200);
    await host.until(() => page.rows()[id] === "acted");
    expect(statesOf(page, a)[id]).toBe("acted");
    expect(page.work(a)?.sources[0]?.status).toBe("running");

    // A second device, or a double click, finds it closed and changes nothing.
    expect(await act(a, id)).toBe(409);
    expect(await (await dismiss(a, id)).json()).toEqual({ closed: false });
    expect(statesOf(page, a)[id]).toBe("acted");
  });

  test("dismiss closes the item, and the transcript row shows it handled after a reload", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await openBot(a);
    const page = await watch();
    const id = await post(a, token, { kind: "failed", title: "t04 failed twice" });
    await host.until(() => page.rows()[id] === "open");

    expect(await (await dismiss(a, id)).json()).toEqual({ closed: true });
    await host.until(() => page.rows()[id] === "dismissed");
    expect(page.work(a)?.sources[0]?.status).toBe("running");
    expect(await act(a, id)).toBe(409);

    // A page that connects later is replayed the closed row, not an open one.
    const later = await watch();
    await host.until(() => later.rows()[id] !== undefined);
    expect(later.rows()[id]).toBe("dismissed");
  });

  test("two connected pages converge on every transition, including for a bot that is not open", async () => {
    const a = host.createBot("Planner");
    const b = host.createBot("Builder");
    const ta = await tokenOf(a);
    const tb = await tokenOf(b);
    await openBot(a);
    const first = await watch();
    const second = await watch();
    const onA = await post(a, ta, { key: "q1" });
    const onB = await post(b, tb, { key: "q1", kind: "done", title: "ready" });
    await host.until(() => first.rows()[onA] === "open" && second.rows()[onA] === "open");

    await act(a, onA);
    await host.until(() => first.rows()[onA] === "acted" && second.rows()[onA] === "acted");
    // The work event follows the row's state change on the stream.
    await host.until(
      () => statesOf(first, a)[onA] === "acted" && statesOf(second, a)[onA] === "acted",
    );
    expect(statesOf(first, a)).toEqual(statesOf(second, a));

    // Bot B is not shown: its item closes anyway, and shows closed once the bot is opened.
    expect(await (await dismiss(b, onB)).json()).toEqual({ closed: true });
    await openBot(b);
    await host.until(() => first.work(b) !== undefined && second.work(b) !== undefined);
    expect(statesOf(first, b)[onB]).toBe("dismissed");
    expect(statesOf(second, b)[onB]).toBe("dismissed");
  });

  test("an item of another bot, an unknown event, a progress event and an unknown bot are refused", async () => {
    const a = host.createBot("Planner");
    const b = host.createBot("Builder");
    const ta = await tokenOf(a);
    const id = await post(a, ta, {});
    const progress = await post(a, ta, { kind: "progress", key: "p1" });

    expect(await act(b, id)).toBe(409);
    expect((await dismiss(a, "no-such-event")).status).toBe(404);
    expect(await act(a, progress)).toBe(409);
    expect((await dismiss("no-such-bot", id)).status).toBe(404);

    const page = await watch();
    await openBot(a);
    await host.until(() => page.work(a) !== undefined);
    expect(statesOf(page, a)[id]).toBe("open");
  });

  test("the routes are for paired devices only, and an event token is no credential for them", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    const id = await post(a, token, {});
    for (const [path, auth] of [
      ["/api/bots/events/dismiss", undefined],
      ["/api/bots/events/dismiss", `Bearer ${token}`],
    ] as const) {
      const res = await fetch(`${host.clientUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: host.clientUrl,
          ...(auth && { authorization: auth }),
        },
        body: JSON.stringify({ botId: a, id }),
      });
      expect(res.status).toBe(401);
    }
    const page = await watch();
    await openBot(a);
    await host.until(() => page.work(a) !== undefined);
    expect(statesOf(page, a)[id]).toBe("open");
  });
});

describe("archiving after the queue is cleared", () => {
  test("a source with an open item cannot be archived until the item is acted on, dismissed or resolved", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await openBot(a);
    const archive = (sourceId: string) =>
      host.ui("/api/bots/events/archive", { botId: a, sourceId });
    const from = (id: string, key: string, over: Record<string, unknown> = {}) =>
      post(a, token, { key, source: { id, label: id }, ...over });
    const acted = await from("fin", "d1", { kind: "done" });
    const dismissed = await from("dead", "s1", { kind: "stopped" });
    await from("asking", "q1");
    await from("asking", "p1", { kind: "progress" });

    for (const id of ["fin", "dead", "asking"]) expect((await archive(id)).status).toBe(409);
    await act(a, acted);
    await dismiss(a, dismissed);
    await from("asking", "p2", { kind: "progress", resolves: ["q1"] });

    for (const id of ["fin", "dead", "asking"]) expect((await archive(id)).status).toBe(200);
    const page = await watch();
    await host.until(() => page.work(a) !== undefined);
    expect(page.work(a)?.sources).toEqual([]);
  });
});

describe("a source resolving its items", () => {
  test("resolves closes the same source's open items, and a key of another source or a closed item is left alone", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await openBot(a);
    const page = await watch();
    const mine = await post(a, token, { key: "q-mine" });
    const handled = await post(a, token, { key: "q-handled", kind: "failed" });
    const other = await post(a, token, {
      key: "q-other",
      source: { id: "export-csv", label: "export-csv" },
    });
    await host.until(() => page.rows()[other] === "open");
    await dismiss(a, handled);
    await host.until(() => page.rows()[handled] === "dismissed");

    const done = await post(a, token, {
      kind: "progress",
      key: "p1",
      title: "answered elsewhere",
      resolves: ["q-mine", "q-handled", "q-other", "no-such-key"],
    });
    await host.until(() => page.rows()[mine] === "resolved");

    expect(page.rows()).toEqual({ [mine]: "resolved", [handled]: "dismissed", [other]: "open" });
    expect(statesOf(page, a)).toMatchObject({
      [mine]: "resolved",
      [handled]: "dismissed",
      [other]: "open",
      [done]: "info",
    });
    const sources = Object.fromEntries(page.work(a)?.sources.map((s) => [s.id, s.status]) ?? []);
    expect(sources).toEqual({ "auth-sso": "running", "export-csv": "needs_you" });
  });

  test("an event that resolves items is itself stored and delivered, and a retried post resolves nothing twice", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await openBot(a);
    const page = await watch();
    const asked = await post(a, token, { key: "q1" });
    await host.until(() => host.messagesOf(a).length === 1);
    await host.until(() => page.rows()[asked] === "open");

    const done = await post(a, token, {
      kind: "done",
      key: "d1",
      title: "all green",
      resolves: ["q1"],
    });
    await host.until(() => page.rows()[asked] === "resolved");
    await host.until(() => page.rows()[done] === "open");
    await host.until(() => host.messagesOf(a).length === 2);

    // The same key again is a duplicate: nothing is delivered or changed.
    const again = await fetch(`${host.clientUrl}/api/bots/${a}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: "done",
        key: "d1",
        source: { id: "auth-sso", label: "auth-sso" },
        title: "all green",
        resolves: ["q1"],
      }),
    });
    expect(again.status).toBe(200);
    expect(host.messagesOf(a)).toHaveLength(2);
  });
});

describe("open items and a restart", () => {
  test("open items stay open, and closed ones stay closed, after the host restarts", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await openBot(a);
    const page = await watch();
    const stays = await post(a, token, { key: "q1", kind: "failed" });
    const acted = await post(a, token, { key: "q2" });
    const dismissed = await post(a, token, { key: "q3", kind: "done" });
    const resolved = await post(a, token, { key: "q4", kind: "stopped" });
    await post(a, token, { kind: "progress", key: "p1", resolves: ["q4"] });
    await host.until(() => Object.keys(page.rows()).length === 4);
    await act(a, acted);
    await dismiss(a, dismissed);
    await host.until(() => page.rows()[dismissed] === "dismissed");
    await host.until(() => page.rows()[resolved] === "resolved");

    await host.restart();
    await openBot(a);
    const reloaded = await watch();
    await host.until(() => reloaded.work(a) !== undefined);

    expect(statesOf(reloaded, a)).toMatchObject({
      [stays]: "open",
      [acted]: "acted",
      [dismissed]: "dismissed",
      [resolved]: "resolved",
    });
    // The item can still be closed after the restart.
    expect(await act(a, stays)).toBe(200);
    await host.until(() => statesOf(reloaded, a)[stays] === "acted");
  });
});

describe("needs-you counts in the bots slice", () => {
  const countsOf = (page: Page) =>
    Object.fromEntries(Object.entries(page.bots()).map(([id, b]) => [id, b.needsYou]));

  test("posting, acting, dismissing and resolving change a bot's count on the stream, for bots that are not open", async () => {
    const open = host.createBot("Planner");
    const [b, c] = [host.createBot("Builder"), host.createBot("Checker")];
    const tb = await tokenOf(b);
    const tc = await tokenOf(c);
    await openBot(open);
    const page = await watch();
    await host.until(() => Object.keys(page.bots()).length === 3);
    expect(countsOf(page)).toEqual({ [open]: 0, [b]: 0, [c]: 0 });

    const question = await post(b, tb, { key: "q1" });
    await host.until(() => page.bots()[b]?.needsYou === 1);
    const failed = await post(b, tb, { key: "f1", kind: "failed" });
    await post(b, tb, { key: "s1", kind: "stopped" });
    await post(b, tb, { key: "d1", kind: "done" });
    await host.until(() => page.bots()[b]?.needsYou === 4);

    // Progress is not an item. Another bot's items are counted apart.
    await post(b, tb, { key: "p1", kind: "progress" });
    await post(c, tc, { key: "q1" });
    await host.until(() => page.bots()[c]?.needsYou === 1);
    expect(countsOf(page)).toEqual({ [open]: 0, [b]: 4, [c]: 1 });

    await act(b, question);
    await host.until(() => page.bots()[b]?.needsYou === 3);
    await dismiss(b, failed);
    await host.until(() => page.bots()[b]?.needsYou === 2);
    // A repeat of a closed item changes nothing; resolving closes the rest of its source's items.
    await act(b, failed);
    await post(b, tb, { key: "p2", kind: "progress", resolves: ["s1", "d1"] });
    await host.until(() => page.bots()[b]?.needsYou === 0);
    expect(countsOf(page)).toEqual({ [open]: 0, [b]: 0, [c]: 1 });
  });

  test("the slice names the sources behind a count, newest first, and when the newest item arrived", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    const page = await watch();
    await host.until(() => page.bots()[a] !== undefined);
    expect(page.bots()[a]).toMatchObject({ needsYouSources: [], needsYouAt: 0 });

    const source = (id: string) => ({ source: { id, label: id } });
    await post(a, token, { key: "a1", ...source("auth-sso") });
    await post(a, token, { key: "b1", ...source("export-csv") });
    const second = await post(a, token, { key: "a2", kind: "failed", ...source("auth-sso") });
    await host.until(() => page.bots()[a]?.needsYou === 3);
    // A source is named once, ranked by its newest open item.
    expect(page.bots()[a]?.needsYouSources).toEqual(["auth-sso", "export-csv"]);
    const at = page.bots()[a]!.needsYouAt;
    expect(at).toBeGreaterThan(0);

    await dismiss(a, second);
    await host.until(() => page.bots()[a]?.needsYou === 2);
    expect(page.bots()[a]?.needsYouSources).toEqual(["export-csv", "auth-sso"]);
    expect(page.bots()[a]?.needsYouAt).toBeLessThanOrEqual(at);
  });

  test("a retried post counts once, and a page that connects later, or after a restart, is told the counts", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await post(a, token, { key: "q1" });
    const retry = await fetch(`${host.clientUrl}/api/bots/${a}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: "question",
        key: "q1",
        source: { id: "auth-sso", label: "auth-sso" },
        title: "Which database?",
      }),
    });
    expect(retry.status).toBe(200);
    await post(a, token, { key: "q2", kind: "failed" });

    const later = await watch();
    await host.until(() => later.bots()[a] !== undefined);
    expect(later.bots()[a]?.needsYou).toBe(2);

    await host.restart();
    const afterRestart = await watch();
    await host.until(() => afterRestart.bots()[a] !== undefined);
    expect(afterRestart.bots()[a]?.needsYou).toBe(2);
  });

  test("deleting a bot takes its items out of the slice and leaves the others' counts", async () => {
    const a = host.createBot("Planner");
    const b = host.createBot("Builder");
    const ta = await tokenOf(a);
    const tb = await tokenOf(b);
    const page = await watch();
    await post(a, ta, { key: "q1" });
    await post(b, tb, { key: "q1" });
    await host.until(() => page.bots()[a]?.needsYou === 1 && page.bots()[b]?.needsYou === 1);
    // The event woke both bots; a working bot cannot be deleted.
    await host.until(() => host.messagesOf(a).length === 1 && page.bots()[a]?.status !== "working");

    expect((await host.ui("/api/bots/delete", { botId: a })).status).toBe(200);
    await host.until(() => page.bots()[a] === undefined);
    expect(countsOf(page)).toEqual({ [b]: 1 });
  });
});
