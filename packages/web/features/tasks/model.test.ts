import { expect, test } from "bun:test";

import type { Item } from "@/host/transcript.ts";

import { RECENT_TASKS, groupTasks, waitsFor, type TaskRow } from "./model.ts";

const task = (taskId: string, state: TaskRow["state"], extra: Partial<TaskRow> = {}): TaskRow => ({
  kind: "task",
  taskId,
  goal: `goal ${taskId}`,
  state,
  startedAt: 1,
  ...extra,
});

test("tasks are grouped by where they stand, ignoring the rest of the thread", () => {
  const items: Item[] = [
    { kind: "user", text: "hi", mentions: undefined },
    task("late", "running", { startedAt: 20 }),
    task("int", "interrupted", { startedAt: 5 }),
    task("q1", "queued", { startedAt: 30 }),
    { kind: "assistant", text: "ok" },
    task("q2", "queued", { startedAt: 10 }),
    task("done", "done", { endedAt: 50 }),
  ];
  const groups = groupTasks(items);
  expect(groups.running.map((t) => t.taskId)).toEqual(["int", "late"]);
  expect(groups.queued.map((t) => t.taskId)).toEqual(["q1", "q2"]);
  expect(groups.recent.map((t) => t.taskId)).toEqual(["done"]);
});

test("recent tasks are the latest ended ones, newest first, of any end", () => {
  const ended = Array.from({ length: RECENT_TASKS + 2 }, (_, i) =>
    task(`t${i}`, (["done", "failed", "cancelled"] as const)[i % 3] ?? "done", { endedAt: i }),
  );
  const { recent } = groupTasks(ended);
  expect(recent).toHaveLength(RECENT_TASKS);
  expect(recent.map((t) => t.taskId)).toEqual(["t6", "t5", "t4", "t3", "t2"]);
});

test("a queued task says what it waits for: the task it follows by its goal, or a free slot", () => {
  const items: Item[] = [task("a", "running"), task("q", "queued", { after: "a" })];
  expect(waitsFor(task("q", "queued", { after: "a" }), items)).toBe("“goal a” to end");
  expect(waitsFor(task("q", "queued"), items)).toBe("a free slot");
  expect(waitsFor(task("q", "queued", { after: "gone" }), items)).toBe("another task to end");
});
