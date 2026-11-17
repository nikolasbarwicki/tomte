import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

const DAY = 24 * 60 * 60_000;
const FLAGS = ["--pause-after-absence-days", "14"];

let host: HandoffHost;
let scratch: string;
const streams: AbortController[] = [];
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

/** The check runs every 20 ms here, so a clock moved forward is noticed at once; the fake clock only moves when a test says. */
async function start(flags: string[] = FLAGS) {
  host = await startHandoffHost(flags, undefined, undefined, { absenceCheckMs: 20 });
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "absence-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
});
afterEach(async () => {
  streams.splice(0).forEach((s) => s.abort());
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

type PageEvent = { type: string; [k: string]: unknown };
type RoutineView = { id: string; name: string; active: boolean; pausedReason: string | null };
type Notice = { title: string; body?: string; state: string };

/**
 * One page's `/api/events` stream from now on. It is how a test looks at the host while the owner is "away": every other request
 * a test makes goes through the paired device and counts as the owner being there.
 */
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
  const latest = (type: string, botId?: string) =>
    seen.filter((e) => e.type === type && (botId === undefined || e.botId === botId)).at(-1);
  return {
    /** Open items per bot, from the latest bots slice. */
    needsYou: (botId: string) =>
      (
        latest("bots") as (PageEvent & { bots: { id: string; needsYou: number }[] }) | undefined
      )?.bots.find((b) => b.id === botId)?.needsYou ?? 0,
    /** The open bot's notices: the events of its "Tomte" source. */
    notices: (botId: string): Notice[] =>
      (
        latest("work", botId) as
          | (PageEvent & { sources: { label: string; events: Notice[] }[] })
          | undefined
      )?.sources.find((s) => s.label === "Tomte")?.events ?? [],
    /** The open bot's routines, as the last routines event showed them. */
    routines: (botId: string) =>
      (latest("routines", botId) as (PageEvent & { routines: RoutineView[] }) | undefined)
        ?.routines ?? [],
  };
}

type Page = Awaited<ReturnType<typeof watch>>;

const routine = async (botId: string, name: string, active = true) => {
  const created = await host.ui("/api/routines/create", {
    botId,
    name,
    instruction: "check the prices",
    schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
    active,
  });
  expect(created.status).toBe(200);
  return ((await created.json()) as RoutineView).id;
};

/** Fails the routine's runs by hand, as `events/notices.test.ts` does, until its failures pause it. */
async function pauseForFailures(botId: string, id: string) {
  host.loopScript(...Array.from({ length: 12 }, () => ({ steps: [{ exit: 1 }] })));
  for (let i = 0; i < 5; i++) {
    const before = ((await (await host.ui("/api/routines/runs", { id })).json()) as unknown[])
      .length;
    expect((await host.ui("/api/routines/run", { id })).status).toBe(200);
    for (let n = 0; n < 400; n++) {
      const runs = (await (await host.ui("/api/routines/runs", { id })).json()) as {
        status: string;
      }[];
      const list = (await (await host.ui("/api/routines/list", { botId })).json()) as {
        id: string;
        running: boolean;
      }[];
      if (runs.length === before + 1 && !list.find((r) => r.id === id)?.running) break;
      await Bun.sleep(25);
    }
  }
}

/**
 * Two bots: `Planner` (open, so the page sees its routines and notices) with an active routine, one the owner switched off and
 * one failures paused; `Other` with an active routine and `Idle` with none.
 */
async function setup() {
  const planner = host.createBot("Planner");
  const other = host.createBot("Other");
  const idle = host.createBot("Idle");
  expect((await host.ui("/api/open", { botId: other })).status).toBe(200);
  const nightly = await routine(planner, "nightly");
  await routine(planner, "mine", false);
  const looping = await routine(planner, "looping");
  await routine(other, "weekly");
  await pauseForFailures(planner, looping);
  expect((await host.ui("/api/open", { botId: planner })).status).toBe(200);
  const page = await watch();
  await host.until(() => page.routines(planner).some((r) => r.pausedReason === "failures"));
  return { planner, other, idle, nightly, page };
}

const state = (page: Page, botId: string) =>
  Object.fromEntries(page.routines(botId).map((r) => [r.name, r.pausedReason ?? r.active]));

const warnings = (page: Page, botId: string) =>
  page.notices(botId).filter((n) => n.title.includes("pause in 2 days"));
const absenceNotices = (page: Page, botId: string) =>
  page.notices(botId).filter((n) => !n.title.includes("5 failed runs"));

// The negative checks below ("still not paused") wait a few real check intervals: there is no event for a check that did nothing.
const SETTLE_MS = 150;

test("12 days away warns once, 14 days pauses every active routine and says so, whatever the event stream does", async () => {
  await start();
  const { planner, other, idle, page } = await setup();
  // The failures notice is the one item Planner starts with.
  await host.until(() => page.notices(planner).length === 1);

  host.advanceClock(12 * DAY);
  await host.until(() => warnings(page, planner).length === 1);
  await host.until(() => page.needsYou(other) === 1);
  expect(page.needsYou(idle)).toBe(0);
  expect(state(page, planner)).toEqual({ nightly: true, mine: false, looping: "failures" });

  // Another day of checks and a stream that reconnects: still one warning, nothing paused, and no presence.
  host.advanceClock(1 * DAY);
  await watch();
  await Bun.sleep(SETTLE_MS);
  expect(warnings(page, planner)).toHaveLength(1);
  expect(page.needsYou(other)).toBe(1);
  expect(state(page, planner).nightly).toBe(true);

  host.advanceClock(1 * DAY);
  await host.until(() => state(page, planner).nightly === "absence");
  expect(state(page, planner)).toEqual({ nightly: "absence", mine: false, looping: "failures" });
  const paused = page.notices(planner).find((n) => n.title.startsWith("Routines paused"));
  expect(paused?.state).toBe("open");
  expect(paused?.body).toContain("nightly");
  expect(paused?.title).toContain("14 days");
  expect(paused?.body).not.toMatch(/mine|looping/);
  await host.until(() => page.needsYou(other) === 2);
  expect(page.needsYou(idle)).toBe(0);
});

test("one request from the paired device resumes what the absence paused and closes its notices, and leaves the rest paused", async () => {
  await start();
  const { planner, other, page } = await setup();

  host.advanceClock(14 * DAY);
  await host.until(() => state(page, planner).nightly === "absence");
  await host.until(() => page.needsYou(other) === 1);

  expect((await host.ui("/api/seen", { botId: planner })).status).toBe(200);
  await host.until(() => state(page, planner).nightly === true);
  expect(state(page, planner)).toEqual({ nightly: true, mine: false, looping: "failures" });
  await host.until(() => absenceNotices(page, planner).every((n) => n.state === "resolved"));
  expect(absenceNotices(page, planner)).toHaveLength(1);
  await host.until(() => page.needsYou(other) === 0);
  // The failures notice is still open: coming back never restarts a broken routine.
  expect(page.needsYou(planner)).toBe(1);
});

test("a later absence is warned about and paused again", async () => {
  await start();
  const { planner, page } = await setup();
  host.advanceClock(14 * DAY);
  await host.until(() => state(page, planner).nightly === "absence");
  expect((await host.ui("/api/seen", { botId: planner })).status).toBe(200);
  await host.until(() => state(page, planner).nightly === true);

  host.advanceClock(12 * DAY);
  await host.until(() => warnings(page, planner).filter((n) => n.state === "open").length === 1);
  host.advanceClock(2 * DAY);
  await host.until(() => state(page, planner).nightly === "absence");
});

test("a restart in between does not reset the clock", async () => {
  await start();
  const { other, page } = await setup();
  host.advanceClock(13 * DAY);
  await host.until(() => page.needsYou(other) === 1);

  await host.restart(FLAGS);
  const restarted = await watch();
  // The host starts on the warning it already raised; one more day pauses Other's routine, which is what a clock kept in the database does.
  await host.until(() => restarted.needsYou(other) === 1);
  host.advanceClock(1 * DAY);
  await host.until(() => restarted.needsYou(other) === 2);
});

test("the setting at 0 never pauses", async () => {
  await start([]);
  const { planner, page } = await setup();
  host.advanceClock(400 * DAY);
  await Bun.sleep(SETTLE_MS);
  expect(state(page, planner)).toEqual({ nightly: true, mine: false, looping: "failures" });
  expect(absenceNotices(page, planner)).toEqual([]);
});

test("with the setting at 2 days there is no warning, only the pause", async () => {
  await start(["--pause-after-absence-days", "2"]);
  const { planner, page } = await setup();
  host.advanceClock(1.5 * DAY);
  await Bun.sleep(SETTLE_MS);
  expect(absenceNotices(page, planner)).toEqual([]);
  host.advanceClock(0.5 * DAY);
  await host.until(() => state(page, planner).nightly === "absence");
});
