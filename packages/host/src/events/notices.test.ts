import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventAccess } from "@tomte/contract/api";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

let host: HandoffHost;
let scratch: string;
const streams: AbortController[] = [];
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "notices-"));
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
  botId: string;
  sources: {
    label: string;
    status: string;
    events: { id: string; kind: string; title: string; body?: string; state: string }[];
  }[];
};

/** One page's `/api/events` stream from now on: what it was replayed on connecting, then what the host broadcasts. */
async function watch() {
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
    /** The latest bots slice: each bot's open-item count and the sources behind it. */
    bots() {
      const latest = seen.filter((e) => e.type === "bots").at(-1) as
        | (PageEvent & {
            bots: { id: string; needsYou: number; needsYouSources: string[] }[];
          })
        | undefined;
      return Object.fromEntries(latest?.bots.map(({ id, ...rest }) => [id, rest]) ?? []);
    },
    work: (botId: string) =>
      seen.filter((e) => e.type === "work" && e.botId === botId).at(-1) as
        | (PageEvent & WorkView)
        | undefined,
    /** Every transcript row of an external event the page received. */
    externalRows: () => seen.filter((e) => e.type === "external"),
  };
}

type Page = Awaited<ReturnType<typeof watch>>;

type RoutineView = {
  id: string;
  active: boolean;
  pausedReason: string | null;
  running: boolean;
  lastRun: { status: string } | null;
};

const routinesOf = async (botId: string) =>
  (await (await host.ui("/api/routines/list", { botId })).json()) as RoutineView[];
const routineOf = async (botId: string, id: string) =>
  (await routinesOf(botId)).find((r) => r.id === id)!;
const runsOf = async (id: string) =>
  (await (await host.ui("/api/routines/runs", { id })).json()) as { status: string }[];

/** The notices of a page's work event for a bot: every event of its "Tomte" source. */
const noticesOf = (page: Page, botId: string) =>
  page.work(botId)?.sources.find((s) => s.label === "Tomte")?.events ?? [];

/**
 * A bot that is not open, with a routine whose every run fails: the fake CLI ends the turn with a crash. The schedule never
 * fires during a test, so the five failures are manual runs, which count like scheduled ones.
 */
async function loopingRoutine() {
  host.loopScript(...Array.from({ length: 12 }, () => ({ steps: [{ exit: 1 }] })));
  const botId = host.createBot("Planner");
  const other = host.createBot("Other");
  expect((await host.ui("/api/open", { botId: other })).status).toBe(200);
  const created = await host.ui("/api/routines/create", {
    botId,
    name: "nightly",
    instruction: "check the prices",
    schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
  });
  const routineId = ((await created.json()) as { id: string }).id;
  return { botId, other, routineId };
}

/** Runs the routine by hand and waits until that run has ended. */
async function runOnce(botId: string, routineId: string) {
  const before = (await runsOf(routineId)).length;
  expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
  for (let i = 0; i < 400; i++) {
    const r = await routineOf(botId, routineId);
    if (!r.running && (await runsOf(routineId)).length === before + 1) return r;
    await Bun.sleep(25);
  }
  throw new Error("the run did not end");
}

async function failFive(botId: string, routineId: string) {
  for (let i = 0; i < 4; i++) {
    const r = await runOnce(botId, routineId);
    expect(r).toMatchObject({ active: true, pausedReason: null, lastRun: { status: "failed" } });
  }
  return runOnce(botId, routineId);
}

test("a routine whose runs always fail pauses itself on the fifth failure and its bot has an item to dismiss", async () => {
  const { botId, other, routineId } = await loopingRoutine();
  const page = await watch();

  const paused = await failFive(botId, routineId);
  expect(paused).toMatchObject({ active: false, pausedReason: "failures" });
  expect(await runsOf(routineId)).toHaveLength(5);

  // The bot was never open: its item is in the bots slice, and nothing was said to the bot about it.
  await host.until(() => page.bots()[botId]?.needsYou === 1);
  expect(page.bots()[botId]?.needsYouSources).toEqual(["Tomte"]);
  expect(page.bots()[other]?.needsYou ?? 0).toBe(0);
  expect(host.messagesOf(botId).filter((m) => m.includes("paused after"))).toEqual([]);

  // Opening the bot shows the item with the reason and the last error, and no transcript row.
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  const opened = await watch();
  await host.until(() => noticesOf(opened, botId).length === 1);
  expect(noticesOf(opened, botId)[0]).toMatchObject({
    kind: "notice",
    title: "nightly paused after 5 failed runs",
    state: "open",
  });
  expect(noticesOf(opened, botId)[0]?.body).toBeString();
  expect(opened.externalRows()).toEqual([]);

  // A restart keeps the pause; nothing runs.
  await host.restart();
  expect(await routineOf(botId, routineId)).toMatchObject({
    active: false,
    pausedReason: "failures",
  });
  await Bun.sleep(100);
  expect(await runsOf(routineId)).toHaveLength(5);

  // The switch resumes it and closes the item as resolved.
  const reopened = await watch();
  await host.until(() => reopened.bots()[botId]?.needsYou === 1);
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  const resumed = await host.ui("/api/routines/update", { id: routineId, active: true });
  expect(await resumed.json()).toMatchObject({ active: true, pausedReason: null });
  await host.until(() => (reopened.bots()[botId]?.needsYou ?? 0) === 0);
  await host.until(() => noticesOf(reopened, botId)[0]?.state === "resolved");
});

test("editing a paused routine does not resume it, and a dismissed notice stays dismissed when it is resumed", async () => {
  const { botId, routineId } = await loopingRoutine();
  const page = await watch();
  await failFive(botId, routineId);
  await host.until(() => page.bots()[botId]?.needsYou === 1);
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  const opened = await watch();
  await host.until(() => noticesOf(opened, botId).length === 1);

  const edited = await host.ui("/api/routines/update", {
    id: routineId,
    instruction: "check the prices twice",
    schedule: { kind: "cron", expr: "0 4 * * *", tz: "UTC" },
  });
  expect(await edited.json()).toMatchObject({ active: false, pausedReason: "failures" });

  const id = noticesOf(opened, botId)[0]!.id;
  const dismissed = await host.ui("/api/bots/events/dismiss", { botId, id });
  expect(await dismissed.json()).toEqual({ closed: true });
  await host.until(() => (page.bots()[botId]?.needsYou ?? 0) === 0);

  await host.ui("/api/routines/update", { id: routineId, active: true });
  expect(await routineOf(botId, routineId)).toMatchObject({ active: true, pausedReason: null });
  await host.until(() => noticesOf(opened, botId)[0]?.state === "dismissed");
});

test("a sender cannot post a notice: the events route refuses the kind", async () => {
  const botId = host.createBot("Planner");
  const { token } = (await (
    await host.ui("/api/bots/events-token", { botId })
  ).json()) as EventAccess;
  const page = await watch();

  const res = await fetch(`${host.clientUrl}/api/bots/${botId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      kind: "notice",
      key: "n1",
      source: { id: "tomte", label: "Tomte" },
      title: "your routines are paused",
    }),
  });
  expect(res.status).toBe(400);
  await Bun.sleep(100);
  expect(page.bots()[botId]?.needsYou ?? 0).toBe(0);
});
