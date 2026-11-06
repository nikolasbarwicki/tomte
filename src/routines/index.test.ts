import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot } from "../bots/index.ts";
import { migrate } from "../platform/db.ts";
import { Conflict, createRoutines, type Executor } from "./index.ts";
import * as store from "./store.ts";
import type { Schedule } from "../contract/events.ts";

const at = (iso: string) => Date.parse(iso);
const hourly: Schedule = { kind: "cron", expr: "0 * * * *", tz: "UTC" };

let cwd: string;
let db: Database;
let clock: number;
let jobs: { prompt: string; resolve(text: string): void; reject(e: Error): void }[];
let routines: ReturnType<typeof createRoutines>;
let botId: string;
let changed: { promise: Promise<string>; resolve(botId: string): void };

const execute: Executor = ({ prompt }) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  jobs.push({ prompt, resolve, reject });
  return { done: promise, stop: (reason) => reject(new Error(reason)) };
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "routines-test-"));
  db = migrate(new Database(":memory:"));
  clock = at("2026-01-01T10:00:00Z");
  jobs = [];
  changed = Promise.withResolvers();
  botId = createBot(cwd, "Bot").id;
  routines = createRoutines({
    db,
    cwd,
    now: () => clock,
    execute,
    onChange: (id) => changed.resolve(id),
  });
});

afterEach(() => {
  routines.stop();
  rmSync(cwd, { recursive: true, force: true });
});

const runsOf = (id: string) => routines.runs(id);

test("reconciling twice catches up once, with the late note", async () => {
  const r = routines.create(botId, { name: "hourly", instruction: "do it", schedule: hourly });
  clock = at("2026-01-01T12:30:00Z");
  routines.start();
  routines.start();
  expect(runsOf(r.id)).toMatchObject([{ trigger: "schedule", status: "running", scheduledFor: at("2026-01-01T12:00:00Z") }]);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].prompt).toContain("30 minutes late");
  changed = Promise.withResolvers();
  jobs[0].resolve("all done\nmore");
  await changed.promise;
  expect(runsOf(r.id)).toMatchObject([{ status: "succeeded", output: "all done\nmore" }]);
});

test("a miss inside the window with catch-up off records one skipped run", () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly, catchUp: false });
  clock = at("2026-01-01T12:30:00Z");
  routines.start();
  routines.start();
  expect(jobs).toHaveLength(0);
  expect(runsOf(r.id)).toMatchObject([{ status: "skipped", error: "missed while offline", scheduledFor: at("2026-01-01T12:00:00Z") }]);
});

test("a miss beyond the window records one skipped run even with catch-up on", () => {
  clock = at("2026-01-01T01:00:00Z");
  const r = routines.create(botId, { name: "d", instruction: "i", schedule: { kind: "cron", expr: "0 0 * * *", tz: "UTC" } });
  clock = at("2026-01-03T13:00:00Z");
  routines.start();
  routines.start();
  expect(jobs).toHaveLength(0);
  expect(runsOf(r.id)).toMatchObject([{ status: "skipped", error: "missed while offline", scheduledFor: at("2026-01-03T00:00:00Z") }]);
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
  expect(runsOf(r.id)).toMatchObject([{ id: "stale", status: "interrupted", error: "app stopped during run" }]);
});

test("a test run while the routine is running is a conflict", () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly, active: false });
  expect(routines.testRun(r.id)).toMatchObject({ trigger: "manual", status: "running", scheduledFor: null });
  expect(() => routines.testRun(r.id)).toThrow(Conflict);
});

test("a scheduled fire during a test run is recorded as skipped", () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  clock = at("2026-01-01T11:05:00Z");
  routines.testRun(r.id);
  routines.start();
  expect(jobs).toHaveLength(1);
  expect(runsOf(r.id).map((x) => [x.trigger, x.status, x.error])).toContainEqual(["schedule", "skipped", "previous run still in progress"]);
  expect(routines.get(r.id).running).toBe(true);
});

test("a one-shot deactivates after firing", async () => {
  const r = routines.create(botId, { name: "once", instruction: "i", schedule: { kind: "once", at: at("2026-01-01T11:00:00Z") } });
  expect(r.nextRunAt).toBe(at("2026-01-01T11:00:00Z"));
  clock = at("2026-01-01T11:01:00Z");
  routines.start();
  changed = Promise.withResolvers();
  jobs[0].resolve("ok");
  await changed.promise;
  expect(routines.get(r.id)).toMatchObject({ active: false, nextRunAt: null, lastRun: { status: "succeeded" } });
});

test("deleting a running routine stops the run and removes its rows", async () => {
  const r = routines.create(botId, { name: "h", instruction: "i", schedule: hourly });
  routines.testRun(r.id);
  await routines.remove(r.id);
  expect(routines.list(botId)).toEqual([]);
  expect(db.query("SELECT count(*) AS n FROM routine_runs").get()).toEqual({ n: 0 });
});
