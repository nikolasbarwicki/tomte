import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Schedule } from "@claudebot/contract/events";
import { z } from "zod";

import { createBot } from "../bots/index.ts";
import type { Events } from "../events/index.ts";
import { migrate } from "../platform/db.ts";
import { defined } from "../testing/defined.ts";
import { createWaits, type Waits } from "../waits/index.ts";
import { Conflict, createRoutines, type Executor, type RunEnd } from "./index.ts";
import * as store from "./store.ts";

const at = (iso: string) => Date.parse(iso);
const hourly: Schedule = { kind: "cron", expr: "0 * * * *", tz: "UTC" };

let cwd: string;
let db: Database;
let clock: number;
let jobs: {
  prompt: string;
  runId: string;
  resumed: boolean;
  resolve(text: string): void;
  reject(e: Error): void;
}[];
let routines: ReturnType<typeof createRoutines>;
let waits: Waits;
let botId: string;
let changed: { promise: Promise<string>; resolve(botId: string): void };
/** What the host told the bot's session, and what the owner's chat was shown. */
let told: string[];
let notices: string[];
/** Every run `onRunEnded` was told about. */
let ended: RunEnd[];
/** Extra routine hosts a test made; stopped after it. */
let onTestEnd: (() => void)[];
/** The host's own needs-you items the routines raised. */
let raised: { botId: string; key: string; title: string; body?: string }[];

/** The host's own needs-you items, recorded in `raised`. */
const events: Pick<Events, "notice" | "resolveNotices"> = {
  notice: (bot, n) => {
    raised.push({ botId: bot, ...n });
    return { id: n.key, duplicate: false };
  },
  resolveNotices() {},
};

const execute: Executor = ({ prompt, runId, resumed }) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  jobs.push({ prompt, runId, resumed, resolve, reject });
  return { done: promise, stop: (reason) => reject(new Error(reason)) };
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "routines-test-"));
  db = migrate(new Database(":memory:"));
  clock = at("2026-01-01T10:00:00Z");
  jobs = [];
  onTestEnd = [];
  told = [];
  notices = [];
  ended = [];
  raised = [];
  changed = Promise.withResolvers();
  botId = createBot(cwd, "Bot").id;
  waits = createWaits({
    db,
    emit() {},
    deliver: (_bot, text) => void told.push(text),
    now: () => clock,
  });
  routines = createRoutines({
    db,
    dataRoot: cwd,
    now: () => clock,
    execute,
    waits,
    notice: async (_bot, text) => void notices.push(text),
    deliver: async (_bot, text) => void told.push(text),
    events,
    onChange: (id) => changed.resolve(id),
    onRunEnded: (end) => void ended.push(end),
  });
  waits.subscribe((e) => {
    if (e.type === "closed") routines.waitClosed(e.wait);
  });
});

afterEach(() => {
  for (const stop of onTestEnd) stop();
  routines.stop();
  waits.close();
  rmSync(cwd, { recursive: true, force: true });
});

const runsOf = (id: string) => routines.runs(id);

test("reconciling twice catches up once, with the late note", async () => {
  const r = routines.create(botId, { name: "hourly", instruction: "do it", schedule: hourly });
  clock = at("2026-01-01T12:30:00Z");
  routines.start();
  routines.start();
  expect(runsOf(r.id)).toMatchObject([
    { trigger: "schedule", status: "running", scheduledFor: at("2026-01-01T12:00:00Z") },
  ]);
  expect(jobs).toHaveLength(1);
  const job = defined(jobs[0], "job");
  expect(job.prompt).toContain("30 minutes late");
  changed = Promise.withResolvers();
  job.resolve("all done\nmore");
  await changed.promise;
  expect(runsOf(r.id)).toMatchObject([{ status: "succeeded", output: "all done\nmore" }]);
});

test("a miss inside the window with catch-up off records one skipped run", () => {
  const r = routines.create(botId, {
    name: "h",
    instruction: "i",
    schedule: hourly,
    catchUp: false,
  });
  clock = at("2026-01-01T12:30:00Z");
  routines.start();
  routines.start();
  expect(jobs).toHaveLength(0);
  expect(runsOf(r.id)).toMatchObject([
    { status: "skipped", error: "missed while offline", scheduledFor: at("2026-01-01T12:00:00Z") },
  ]);
});

test("a miss beyond the window records one skipped run even with catch-up on", () => {
  clock = at("2026-01-01T01:00:00Z");
  const r = routines.create(botId, {
    name: "d",
    instruction: "i",
    schedule: { kind: "cron", expr: "0 0 * * *", tz: "UTC" },
  });
  clock = at("2026-01-03T13:00:00Z");
  routines.start();
  routines.start();
  expect(jobs).toHaveLength(0);
  expect(runsOf(r.id)).toMatchObject([
    { status: "skipped", error: "missed while offline", scheduledFor: at("2026-01-03T00:00:00Z") },
  ]);
});

test("a run left running by a previous process becomes interrupted", () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  store.insertRun(db, {
    id: "stale",
    routineId: r.id,
    trigger: "manual",
    scheduledFor: null,
    status: "running",
    sessionId: null,
    output: null,
    error: null,
    startedAt: clock,
    finishedAt: null,
  });
  routines.start();
  expect(runsOf(r.id)).toMatchObject([
    { id: "stale", status: "interrupted", error: "app stopped during run" },
  ]);
});

test("a test run while the routine is running is a conflict", () => {
  const r = routines.create(botId, {
    name: "h",
    instruction: "i",
    schedule: hourly,
    active: false,
  });
  expect(routines.testRun(r.id)).toMatchObject({
    trigger: "manual",
    status: "running",
    scheduledFor: null,
  });
  expect(() => routines.testRun(r.id)).toThrow(Conflict);
});

test("a scheduled fire during a test run is recorded as skipped", () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  clock = at("2026-01-01T11:05:00Z");
  routines.testRun(r.id);
  routines.start();
  expect(jobs).toHaveLength(1);
  expect(runsOf(r.id).map((x) => [x.trigger, x.status, x.error])).toContainEqual([
    "schedule",
    "skipped",
    "previous run still in progress",
  ]);
  expect(routines.get(r.id).running).toBe(true);
});

test("a one-shot deactivates after firing", async () => {
  const r = routines.create(botId, {
    name: "once",
    instruction: "i",
    schedule: { kind: "once", at: at("2026-01-01T11:00:00Z") },
  });
  expect(r.nextRunAt).toBe(at("2026-01-01T11:00:00Z"));
  clock = at("2026-01-01T11:01:00Z");
  routines.start();
  changed = Promise.withResolvers();
  defined(jobs[0], "job").resolve("ok");
  await changed.promise;
  expect(routines.get(r.id)).toMatchObject({
    active: false,
    nextRunAt: null,
    lastRun: { status: "succeeded" },
  });
});

test("deleting a running routine stops the run and removes its rows", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  routines.testRun(r.id);
  await routines.remove(r.id);
  expect(routines.list(botId)).toEqual([]);
  expect(db.query("SELECT count(*) AS n FROM routine_runs").get()).toEqual({ n: 0 });
});

test("a stored schedule that does not match its schema throws a ZodError on read", () => {
  const r = routines.create(botId, { name: "hourly", instruction: "do it", schedule: hourly });
  db.run("UPDATE routines SET schedule = ? WHERE id = ?", [JSON.stringify({ kind: "cron" }), r.id]);
  expect(() => store.getRoutine(db, r.id)).toThrow(z.ZodError);
});

const DAY = 24 * 60 * 60_000;

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
};

/** A request to the owner that a routine turn raised, as `parkingDelegate` does. */
const askApproval = (runId: string) =>
  waits.open(botId, {
    kind: "tool_approval",
    runId,
    payload: {
      tool: "mcp__fx__send",
      input: { to: "ana" },
      canonical: '{"to":"ana"}',
      reason: "send",
    },
    actions: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
  }).id;

const askQuestion = (runId: string) =>
  waits.open(botId, {
    kind: "question",
    runId,
    payload: { question: "Which list?" },
    actions: [],
  }).id;

/** A test run whose first turn raises `count` requests and ends; resolves once the run is waiting. */
async function park(count = 1) {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  routines.testRun(r.id);
  const job = defined(jobs[0], "job");
  const ids = [askApproval(job.runId), ...(count > 1 ? [askQuestion(job.runId)] : [])];
  job.resolve("I asked the owner");
  await until(() => routines.get(r.id).lastRun?.status === "waiting");
  return { r, ids, runId: job.runId };
}

test("a turn that ends on a request to the owner parks the run; occurrences are skipped and test runs refused until it is answered", async () => {
  const { r } = await park();
  expect(routines.get(r.id)).toMatchObject({
    running: false,
    lastRun: { status: "waiting", output: null },
  });

  // A catch-up of the hourly schedule meets the parked run, which a reconcile leaves alone.
  clock = at("2026-01-01T11:05:00Z");
  routines.start();
  expect(runsOf(r.id).map((x) => [x.status, x.error])).toContainEqual([
    "skipped",
    "previous run is waiting for you",
  ]);
  expect(runsOf(r.id).filter((x) => x.status === "waiting")).toHaveLength(1);
  expect(routines.get(r.id).lastRun?.status).toBe("waiting");
  expect(() => routines.testRun(r.id)).toThrow(Conflict);
  expect(jobs).toHaveLength(1);
});

test("an answer resumes the run in the same session with the owner's message, and the run ends with the last turn's text", async () => {
  const { r, ids, runId } = await park();
  expect(waits.answer(defined(ids[0]), "allow")).toBe(true);
  await until(() => jobs.length === 2);
  const resumed = defined(jobs[1], "job");
  expect(resumed).toMatchObject({ runId, resumed: true });
  expect(resumed.prompt).toContain(`<human-wait-result id="${ids[0]}">`);
  expect(resumed.prompt).toContain("exactly that input");
  expect(resumed.prompt).not.toContain("scheduled-routine");
  expect(routines.get(r.id)).toMatchObject({ running: true });
  expect(runsOf(r.id)[0]).toMatchObject({ status: "running", output: null });

  resumed.resolve("sent it");
  await until(() => runsOf(r.id)[0]?.status === "succeeded");
  expect(runsOf(r.id)).toHaveLength(1);
  expect(runsOf(r.id)[0]).toMatchObject({ output: "sent it" });
  // The answer reached the run, not the bot's session as a message of its own.
  expect(told).toEqual([]);
});

test("a denial's note is in the resume message", async () => {
  const { ids } = await park();
  expect(waits.answer(defined(ids[0]), "deny", "not at night")).toBe(true);
  await until(() => jobs.length === 2);
  expect(defined(jobs[1]).prompt).toContain("denied");
  expect(defined(jobs[1]).prompt).toContain("not at night");
});

test("several requests of one park resume the run once, after the last answer, with every answer in one message", async () => {
  const { ids } = await park(2);
  expect(waits.answer(defined(ids[0]), "allow")).toBe(true);
  await Bun.sleep(30);
  expect(jobs).toHaveLength(1);
  expect(waits.answer(defined(ids[1]), "List A")).toBe(true);
  await until(() => jobs.length === 2);
  const { prompt } = defined(jobs[1], "job");
  expect(prompt).toContain(`<human-wait-result id="${ids[0]}">`);
  expect(prompt).toContain(`<human-wait-result id="${ids[1]}">`);
  expect(prompt).toContain("Which list?");
  expect(prompt).toContain("List A");
});

test("an answer that comes in while the turn still runs does not park: the turn's end continues the run at once", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  routines.testRun(r.id);
  const first = defined(jobs[0], "job");
  const id = askApproval(first.runId);
  expect(waits.answer(id, "allow")).toBe(true);
  expect(jobs).toHaveLength(1);

  first.resolve("asking and carrying on");
  await until(() => jobs.length === 2);
  expect(defined(jobs[1]).prompt).toContain(`<human-wait-result id="${id}">`);
  expect(routines.get(r.id)).toMatchObject({ running: true });
  expect(runsOf(r.id)[0]?.status).toBe("running");

  defined(jobs[1]).resolve("finished");
  await until(() => runsOf(r.id)[0]?.status === "succeeded");
  expect(runsOf(r.id)[0]).toMatchObject({ output: "finished" });
  expect(told).toEqual([]);
});

test("a turn that fails fails the run and cancels its waits, telling nobody", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  routines.testRun(r.id);
  const job = defined(jobs[0], "job");
  askApproval(job.runId);
  job.reject(new Error("the CLI crashed"));
  await until(() => runsOf(r.id)[0]?.status === "failed");
  expect(runsOf(r.id)[0]).toMatchObject({ error: "the CLI crashed" });
  expect(waits.list(botId)).toEqual([]);
  expect(told).toEqual([]);
});

test("a park that goes 24 hours unanswered fails the run with 'approval expired', tells the bot and the owner, and drops the other requests", async () => {
  const { r } = await park(2);
  clock += DAY;
  waits.start();
  expect(runsOf(r.id)[0]).toMatchObject({ status: "failed", error: "approval expired" });
  expect(waits.list(botId)).toEqual([]);
  await until(() => told.length === 1);
  expect(defined(told[0])).toContain("expired");
  expect(defined(told[0])).toContain("nothing was approved");
  expect(defined(told[0])).toContain("Do not retry");
  expect(notices).toEqual(['Routine "h" failed: approval expired']);
  // The routine is free again.
  expect(() => routines.testRun(r.id)).not.toThrow();
});

test("a new session fails the parked run and cancels its waits, without a message to the bot", async () => {
  const { r } = await park();
  routines.sessionEnded(botId);
  expect(runsOf(r.id)[0]).toMatchObject({
    status: "failed",
    error: "session ended while waiting for you",
  });
  expect(waits.list(botId)).toEqual([]);
  await Bun.sleep(20);
  expect(told).toEqual([]);
});

test("deleting a parked routine cancels its waits and removes its run", async () => {
  const { r } = await park();
  await routines.remove(r.id);
  expect(waits.list(botId)).toEqual([]);
  expect(db.query("SELECT count(*) AS n FROM routine_runs").get()).toEqual({ n: 0 });
  expect(told).toEqual([]);
});

test("what a run that the last process left running asked the owner is cancelled at start", () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  store.insertRun(db, {
    id: "stale",
    routineId: r.id,
    trigger: "manual",
    scheduledFor: null,
    status: "running",
    sessionId: null,
    output: null,
    error: null,
    startedAt: clock,
    finishedAt: null,
  });
  askApproval("stale");
  routines.start();
  expect(runsOf(r.id)[0]).toMatchObject({ id: "stale", status: "interrupted" });
  expect(waits.list(botId)).toEqual([]);
});

test("resuming a run that is not waiting is refused", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  const run = routines.testRun(r.id);
  await expect(routines.resume(run.id, "hello")).rejects.toThrow(Conflict);
  await expect(routines.resume("missing", "hello")).rejects.toThrow(Conflict);
});

test("a database made before parked runs keeps its runs and their order, and takes waiting ones", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  db.run("DROP TABLE routine_runs");
  db.run(`CREATE TABLE routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
    scheduled_for INTEGER,
    status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted','skipped')),
    session_id TEXT, output TEXT, error TEXT,
    started_at INTEGER NOT NULL, finished_at INTEGER,
    UNIQUE (routine_id, scheduled_for))`);
  const insert = db.query(
    "INSERT INTO routine_runs (id, routine_id, trigger, scheduled_for, status, output, started_at) VALUES (?, ?, 'manual', NULL, 'succeeded', ?, ?)",
  );
  insert.run("r1", r.id, "first", 1);
  insert.run("r2", r.id, "second", 2);
  db.run("ALTER TABLE human_waits DROP COLUMN delivered_at");
  db.run("PRAGMA user_version = 16");

  migrate(db);

  expect(runsOf(r.id).map((x) => [x.id, x.output])).toEqual([
    ["r2", "second"],
    ["r1", "first"],
  ]);
  store.insertRun(db, {
    id: "parked",
    routineId: r.id,
    trigger: "manual",
    scheduledFor: null,
    status: "waiting",
    sessionId: null,
    output: null,
    error: null,
    startedAt: 3,
    finishedAt: null,
  });
  expect(routines.get(r.id).lastRun).toMatchObject({ id: "parked", status: "waiting" });
  // A parked run answered after the upgrade resumes with the answer, and the wait counts as delivered.
  const id = askApproval("parked");
  waits.answer(id, "allow");
  await until(() => jobs.length === 1);
  expect(defined(jobs[0]).prompt).toContain(`<human-wait-result id="${id}">`);
  expect(waits.ofRun("parked")).toEqual([]);
});

/** What `onRunEnded` was told, as status and error per run. */
const endings = () => ended.map((e) => [e.run.status, e.run.error, e.expired] as const);

test("a run that succeeds is reported once, with its output and no expired waits", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  routines.testRun(r.id);
  changed = Promise.withResolvers();
  defined(jobs[0], "job").resolve("all done");
  await changed.promise;
  expect(ended).toHaveLength(1);
  expect(ended[0]).toMatchObject({
    run: { status: "succeeded", output: "all done", trigger: "manual" },
    routine: { id: r.id, name: "h" },
    expired: [],
  });
});

test("a run whose turn fails is reported once as failed, a manual one like any other", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  routines.testRun(r.id);
  defined(jobs[0], "job").reject(new Error("the CLI crashed"));
  await until(() => ended.length > 0);
  await Bun.sleep(20);
  expect(endings()).toEqual([["failed", "the CLI crashed", []]]);
  expect(ended[0]?.run.trigger).toBe("manual");
});

test("a run left running by a previous process is reported as interrupted at start, once however often it starts", () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  store.insertRun(db, {
    id: "stale",
    routineId: r.id,
    trigger: "schedule",
    scheduledFor: null,
    status: "running",
    sessionId: null,
    output: null,
    error: null,
    startedAt: clock,
    finishedAt: null,
  });
  routines.start();
  routines.start();
  expect(endings()).toEqual([["interrupted", "app stopped during run", []]]);
});

test("a park that expires is reported once, with the title of what lapsed, and a late answer reports nothing more", async () => {
  const { r } = await park(2);
  clock += DAY;
  waits.start();
  expect(ended).toHaveLength(1);
  expect(ended[0]).toMatchObject({
    run: { status: "failed", error: "approval expired" },
    routine: { id: r.id },
    expired: ["approval for mcp__fx__send"],
  });
  waits.start();
  expect(ended).toHaveLength(1);
});

test("a parked run that resumes and ends is reported once, after the last turn", async () => {
  const { ids, runId } = await park();
  expect(ended).toEqual([]);
  waits.answer(defined(ids[0]), "allow");
  await until(() => jobs.length === 2);
  expect(ended).toEqual([]);
  defined(jobs[1], "resume").resolve("finished");
  await until(() => ended.length > 0);
  expect(ended).toHaveLength(1);
  expect(ended[0]?.run).toMatchObject({ id: runId, status: "succeeded", output: "finished" });
});

test("a new session that fails a parked run reports it as an ordinary failure", async () => {
  await park();
  routines.sessionEnded(botId);
  expect(endings()).toEqual([["failed", "session ended while waiting for you", []]]);
});

test("a skipped run and a run stopped by deleting its routine are not reported", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  clock = at("2026-01-01T11:05:00Z");
  routines.testRun(r.id);
  routines.start();
  expect(runsOf(r.id).map((x) => x.status)).toContain("skipped");
  await routines.remove(r.id);
  expect(ended).toEqual([]);
});

test("a run stopped by shutdown is left running, and the next start reports it as interrupted", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  routines.testRun(r.id);
  routines.stop();
  await Bun.sleep(20);
  expect(runsOf(r.id)[0]?.status).toBe("running");
  expect(ended).toEqual([]);
  const again = createRoutines({
    db,
    dataRoot: cwd,
    now: () => clock,
    execute,
    waits,
    notice: async () => {},
    deliver: async () => {},
    onChange: () => {},
    events,
    onRunEnded: (end) => void ended.push(end),
  });
  again.start();
  expect(endings()).toEqual([["interrupted", "app stopped during run", []]]);
  again.stop();
});

test("a failing onRunEnded is logged and the run's final status stands", async () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const failing = createRoutines({
    db,
    dataRoot: cwd,
    now: () => clock,
    execute,
    waits,
    notice: async () => {},
    deliver: async () => {},
    onChange: () => {},
    events,
    onRunEnded: () => {
      throw new Error("no channel");
    },
  });
  const r = failing.create(botId, { name: "f", instruction: "i", schedule: hourly, active: false });
  failing.testRun(r.id);
  defined(jobs[0], "job").resolve("ok");
  await until(() => failing.get(r.id).lastRun?.status === "succeeded");
  expect(quiet).toHaveBeenCalledWith(expect.stringContaining("no channel"));
  quiet.mockRestore();
  failing.stop();
});

const CAP = 40;

/** A routine host with a small cap over the same database; `stopped` counts the executor's stops. */
function capped(exited = "Claude Code exited before the turn produced a result") {
  const turns: { resolve(text: string): void; reject(e: Error): void }[] = [];
  const stopped: string[] = [];
  const timed = createRoutines({
    db,
    dataRoot: cwd,
    now: () => clock,
    runCapMs: CAP,
    execute: () => {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      turns.push({ resolve, reject });
      return {
        done: promise,
        stop: (reason) => {
          stopped.push(reason);
          reject(new Error(exited));
        },
      };
    },
    waits,
    notice: async () => {},
    deliver: async () => {},
    events,
    onChange: (id) => changed.resolve(id),
    onRunEnded: () => {},
  });
  onTestEnd.push(() => timed.stop());
  return { timed, turns, stopped };
}

test("a run that works past the cap fails with the limit, not the stopped executor's error, and frees the routine", async () => {
  const { timed, turns, stopped } = capped();
  const r = timed.create(botId, { name: "h", instruction: "i", schedule: hourly });
  timed.testRun(r.id);
  changed = Promise.withResolvers();
  await changed.promise;
  await until(() => timed.get(r.id).lastRun?.status === "failed");
  expect(timed.get(r.id)).toMatchObject({
    running: false,
    lastRun: { status: "failed", error: "run exceeded the 40 ms time limit" },
  });
  expect(stopped).toEqual(["run exceeded the 40 ms time limit"]);
  // The next occurrence starts normally.
  timed.testRun(r.id);
  expect(turns).toHaveLength(2);
  expect(timed.get(r.id).running).toBe(true);
});

test("a run whose executor never settles after stop still fails at the cap", async () => {
  const hung = createRoutines({
    db,
    dataRoot: cwd,
    now: () => clock,
    runCapMs: CAP,
    execute: () => ({ done: new Promise<string>(() => {}), stop() {} }),
    waits,
    notice: async () => {},
    deliver: async () => {},
    events,
    onChange: () => {},
    onRunEnded: () => {},
  });
  onTestEnd.push(() => hung.stop());
  const r = hung.create(botId, { name: "h", instruction: "i", schedule: hourly });
  hung.testRun(r.id);
  await until(() => hung.get(r.id).lastRun?.status === "failed");
  expect(hung.get(r.id)).toMatchObject({
    running: false,
    lastRun: { error: expect.stringContaining("time limit") },
  });
});

test("a scheduled run has the same cap", async () => {
  const { timed } = capped();
  clock = at("2026-01-01T10:30:00Z");
  const r = timed.create(botId, { name: "h", instruction: "i", schedule: hourly });
  clock = at("2026-01-01T11:00:30Z");
  timed.start();
  expect(timed.get(r.id).lastRun).toMatchObject({ trigger: "schedule", status: "running" });
  await until(() => timed.get(r.id).lastRun?.status === "failed");
  expect(timed.get(r.id).lastRun).toMatchObject({ error: "run exceeded the 40 ms time limit" });
});

test("a run that finishes or fails before the cap is unaffected and its clock never fires", async () => {
  const { timed, turns, stopped } = capped();
  const r = timed.create(botId, { name: "h", instruction: "i", schedule: hourly });
  timed.testRun(r.id);
  defined(turns[0]).resolve("done in time");
  await until(() => timed.get(r.id).lastRun?.status === "succeeded");
  timed.testRun(r.id);
  defined(turns[1]).reject(new Error("boom"));
  await until(() => timed.get(r.id).lastRun?.status === "failed");
  await Bun.sleep(CAP * 3);
  expect(stopped).toEqual([]);
  expect(runsOf(r.id).map((x) => [x.status, x.error])).toEqual([
    ["failed", "boom"],
    ["succeeded", null],
  ]);
});

test("deleting a running routine and shutting down leave no clock to fire", async () => {
  const { timed, stopped } = capped();
  const gone = timed.create(botId, { name: "a", instruction: "i", schedule: hourly });
  timed.testRun(gone.id);
  await timed.remove(gone.id);
  const open = timed.create(botId, { name: "b", instruction: "i", schedule: hourly });
  timed.testRun(open.id);
  timed.stop();
  await Bun.sleep(CAP * 3);
  expect(stopped).toEqual(["routine deleted", "shutdown"]);
});

/** Runs the routine by hand and fails its turn; resolves once the run has ended. */
async function failRun(id: string, error = "the CLI crashed") {
  routines.testRun(id);
  defined(jobs.at(-1), "job").reject(new Error(error));
  await until(() => !routines.get(id).running);
  expect(routines.get(id).lastRun).toMatchObject({ status: "failed", error });
}

async function succeedRun(id: string) {
  routines.testRun(id);
  defined(jobs.at(-1), "job").resolve("fine");
  await until(() => !routines.get(id).running);
  expect(routines.get(id).lastRun?.status).toBe("succeeded");
}

const interrupted = (routineId: string, n: number) =>
  store.insertRun(db, {
    id: `int-${n}`,
    routineId,
    trigger: "manual",
    scheduledFor: null,
    status: "interrupted",
    sessionId: null,
    output: null,
    error: "app stopped during run",
    startedAt: clock,
    finishedAt: clock,
  });

test("the fifth failed run in a row pauses the routine and tells its owner once, the fourth does not", async () => {
  const r = routines.create(botId, { name: "digest", instruction: "i", schedule: hourly });
  for (let i = 0; i < 4; i++) await failRun(r.id);
  expect(routines.get(r.id)).toMatchObject({ active: true, pausedReason: null });
  expect(raised).toEqual([]);

  await failRun(r.id, "the page is gone");
  expect(routines.get(r.id)).toMatchObject({
    active: false,
    pausedReason: "failures",
    nextRunAt: null,
  });
  expect(raised).toMatchObject([
    { botId, title: "digest paused after 5 failed runs", body: "the page is gone" },
  ]);
});

test("a succeeded run between failures resets the count", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  for (let i = 0; i < 4; i++) await failRun(r.id);
  await succeedRun(r.id);
  for (let i = 0; i < 4; i++) await failRun(r.id);
  expect(routines.get(r.id)).toMatchObject({ active: true, pausedReason: null });
  await failRun(r.id);
  expect(routines.get(r.id)).toMatchObject({ active: false, pausedReason: "failures" });
});

test("interrupted and skipped runs are neither failures nor a reset", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  for (let i = 0; i < 4; i++) await failRun(r.id);
  interrupted(r.id, 1);
  clock = at("2026-01-01T10:30:00Z");
  routines.start();
  expect(routines.get(r.id)).toMatchObject({ active: true, pausedReason: null });
  await failRun(r.id);
  expect(routines.get(r.id)).toMatchObject({ active: false, pausedReason: "failures" });
});

test("a pause stands until the switch is turned on, which clears the reason and does not catch up", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  for (let i = 0; i < 5; i++) await failRun(r.id);

  routines.update(r.id, { name: "renamed", instruction: "new", schedule: hourly });
  routines.update(r.id, { schedule: { kind: "cron", expr: "30 * * * *", tz: "UTC" } });
  expect(routines.get(r.id)).toMatchObject({ active: false, pausedReason: "failures" });

  clock = at("2026-01-01T15:10:00Z");
  routines.update(r.id, { active: true });
  expect(routines.get(r.id)).toMatchObject({ active: true, pausedReason: null });
  const before = jobs.length;
  routines.start();
  expect(jobs).toHaveLength(before);
});

test("a routine its owner paused has no reason, and a failed manual run of a paused routine does not pause it again", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  routines.update(r.id, { active: false });
  expect(routines.get(r.id)).toMatchObject({ active: false, pausedReason: null });
  for (let i = 0; i < 5; i++) await failRun(r.id);
  expect(routines.get(r.id)).toMatchObject({ active: false, pausedReason: null });
  expect(raised).toEqual([]);
});

test("a run that exceeds the time limit is a failed run and counts toward the pause", async () => {
  const { timed, turns } = capped();
  const r = timed.create(botId, { name: "slow", instruction: "i", schedule: hourly });
  for (let i = 0; i < 4; i++) {
    timed.testRun(r.id);
    defined(turns[i]).reject(new Error("boom"));
    await until(() => !timed.get(r.id).running);
  }
  expect(timed.get(r.id)).toMatchObject({ active: true, pausedReason: null });

  timed.testRun(r.id);
  await until(() => !timed.get(r.id).running);
  expect(timed.get(r.id)).toMatchObject({
    active: false,
    pausedReason: "failures",
    lastRun: { error: "run exceeded the 40 ms time limit" },
  });
  expect(raised).toMatchObject([
    { title: "slow paused after 5 failed runs", body: "run exceeded the 40 ms time limit" },
  ]);
});
