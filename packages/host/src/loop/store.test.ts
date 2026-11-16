import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { migrate } from "../platform/db.ts";
import { createLoopStore, isFinal, type LoopStore } from "./store.ts";

let store: LoopStore;
beforeEach(() => {
  store = createLoopStore(migrate(new Database(":memory:")));
});

const task = (taskId: string, startedAt: number) => ({
  taskId,
  agentType: "researcher",
  model: "sonnet",
  effort: "medium",
  goal: `goal ${taskId}`,
  status: "running" as const,
  startedAt,
});

test("a database made before queued tasks keeps its tasks and gains what they wait for", () => {
  const db = migrate(new Database(":memory:"));
  createLoopStore(db)
    .session("bot", "s")
    .putTask({ taskId: "t", goal: "g", status: "running", startedAt: 1 }, 1);
  db.run("ALTER TABLE loop_tasks DROP COLUMN after_task");
  db.run("PRAGMA user_version = 14");

  migrate(db);

  const log = createLoopStore(db).session("bot", "s");
  expect(log.getTask("t")).toMatchObject({ status: "running" });
  log.putTask({ taskId: "q", goal: "g", status: "queued", startedAt: 2, after: "t" }, 2);
  expect(log.getTask("q")?.after).toBe("t");
});

describe("queued tasks", () => {
  test("keep what they wait for, which follows the task that replaces a queue entry", () => {
    const log = store.session("bot", "s");
    log.putTask({ taskId: "q-1", goal: "first", status: "queued", startedAt: 1 }, 1);
    log.putTask({ taskId: "q-2", goal: "second", status: "queued", startedAt: 2, after: "q-1" }, 2);
    expect(log.getTask("q-1")).not.toHaveProperty("after");
    expect(log.getTask("q-2")?.after).toBe("q-1");

    log.removeTask("q-1");
    log.retarget("q-1", "agent-1");
    expect(log.getTask("q-1")).toBeUndefined();
    expect(log.getTask("q-2")?.after).toBe("agent-1");
    // Another session's tasks are not touched.
    store.session("bot", "other").putTask({ ...task("x", 1), after: "q-1" }, 1);
    log.retarget("agent-1", "agent-2");
    expect(store.session("bot", "other").getTask("x")?.after).toBe("q-1");
  });

  test("count as active for the bot until they start, are cancelled or fail", () => {
    const log = store.session("bot", "s");
    log.putTask({ taskId: "q-1", goal: "g", status: "queued", startedAt: 1 }, 1);
    expect(store.hasActive("bot")).toBe(true);
    expect(store.hasActive("other")).toBe(false);
    log.setStatus("q-1", "cancelled", 2);
    expect(store.hasActive("bot")).toBe(false);
  });
});

describe("tasks", () => {
  test("are kept per bot session and listed by start", () => {
    const a = store.session("bot", "s1");
    a.putTask(task("late", 20), 20);
    a.putTask(task("early", 10), 10);
    store.session("bot", "s2").putTask(task("other", 5), 5);

    expect(a.tasks().map((t) => t.taskId)).toEqual(["early", "late"]);
    expect(a.getTask("other")).toBeUndefined();
    expect(a.getTask("early")).toEqual({ ...task("early", 10), updatedAt: 10 });
  });

  test("a task put again keeps its start and takes the new state, so a resumed run is the same task", () => {
    const log = store.session("bot", "s");
    log.putTask(task("t", 10), 10);
    log.setStatus("t", "done", 30);
    expect(log.getTask("t")).toMatchObject({ status: "done", endedAt: 30 });

    log.putTask({ ...task("t", 99), goal: "again" }, 40);
    expect(log.getTask("t")).toEqual({
      ...task("t", 10),
      goal: "again",
      updatedAt: 40,
    });
  });

  test("end only in a final state, and ending clears again when the task runs on", () => {
    const log = store.session("bot", "s");
    log.putTask(task("t", 1), 1);
    log.setStatus("t", "interrupted", 2);
    expect(log.getTask("t")?.endedAt).toBeUndefined();
    log.setStatus("t", "failed", 3);
    expect(log.getTask("t")?.endedAt).toBe(3);
    log.setStatus("t", "running", 4);
    expect(log.getTask("t")?.endedAt).toBeUndefined();
    expect(["done", "failed", "cancelled"].every((s) => isFinal(s as "done"))).toBe(true);
    expect(["queued", "running", "interrupted"].some((s) => isFinal(s as "done"))).toBe(false);
  });
});

describe("the log", () => {
  test("returns each kind in the order it was appended, optionally for one task", () => {
    const log = store.session("bot", "s");
    log.append({ taskId: "a", at: 2, kind: "report", text: "first" });
    log.append({ taskId: "b", at: 1, kind: "report", text: "second" });
    log.append({ taskId: "a", at: 3, kind: "activity", type: "search", text: "query" });
    log.append({
      taskId: "a",
      at: 4,
      kind: "progress",
      progress: { phase: "p", finding: null, next: "n" },
    });
    log.append({ taskId: "a", at: 5, kind: "steer", state: "sent", text: "go on" });

    expect(log.events("report").map((e) => e.text)).toEqual(["first", "second"]);
    expect(log.events("report", "b")).toEqual([
      { kind: "report", taskId: "b", at: 1, text: "second" },
    ]);
    expect(log.events("activity")).toEqual([
      { kind: "activity", taskId: "a", at: 3, type: "search", text: "query" },
    ]);
    expect(log.events("progress")[0]?.progress).toEqual({ phase: "p", finding: null, next: "n" });
    expect(log.events("steer")[0]).toMatchObject({ state: "sent", text: "go on" });
    expect(store.session("bot", "other").events("report")).toEqual([]);
  });
});

describe("the store", () => {
  test("hasActive is true for a queued or running task in any of the bot's sessions, and for nothing else", () => {
    const old = store.session("bot", "old");
    old.putTask(task("t", 1), 1);
    expect(store.hasActive("bot")).toBe(true);
    expect(store.hasActive("someone else")).toBe(false);

    old.setStatus("t", "interrupted", 2);
    expect(store.hasActive("bot")).toBe(false);
    old.setStatus("t", "queued", 3);
    expect(store.hasActive("bot")).toBe(true);
    old.setStatus("t", "done", 4);
    expect(store.hasActive("bot")).toBe(false);
  });

  test("interruptRunning marks running tasks only and says how many", () => {
    const log = store.session("bot", "s");
    log.putTask(task("run", 1), 1);
    log.putTask({ ...task("wait", 2), status: "queued" }, 2);
    log.putTask({ ...task("fin", 3), status: "done" }, 3);

    expect(store.interruptRunning(50)).toBe(1);
    expect(log.tasks().map((t) => [t.taskId, t.status])).toEqual([
      ["run", "interrupted"],
      ["wait", "queued"],
      ["fin", "done"],
    ]);
    expect(store.interruptRunning(60)).toBe(0);
  });

  test("removeBot forgets that bot's tasks and log and no one else's", () => {
    for (const bot of ["gone", "kept"]) {
      const log = store.session(bot, "s");
      log.putTask(task("t", 1), 1);
      log.append({ taskId: "t", at: 1, kind: "report", text: "r" });
    }
    store.removeBot("gone");

    expect(store.session("gone", "s").tasks()).toEqual([]);
    expect(store.session("gone", "s").events("report")).toEqual([]);
    expect(store.session("kept", "s").tasks()).toHaveLength(1);
    expect(store.session("kept", "s").events("report")).toHaveLength(1);
  });
});
