import { expect, test } from "bun:test";

import type { ServerEvent } from "@claudebot/contract/events";

import { reduce, type Item } from "./transcript.ts";

const play = (events: ServerEvent[]) => events.reduce<Item[]>(reduce, []);

test("a message queued mid-reply does not split the bot's reply", () => {
  const items = play([
    { type: "user", text: "write" },
    { type: "text_start" },
    { type: "delta", text: "The Writer sh" },
    { type: "queued", id: "q1", text: "and tell me a joke" },
    { type: "delta", text: "apes the words" },
  ]);
  expect(items).toEqual([
    { kind: "user", text: "write", mentions: undefined },
    { kind: "assistant", text: "The Writer shapes the words" },
    { kind: "queued", id: "q1", text: "and tell me a joke", mentions: undefined },
  ]);
});

test("a queued message stays after the live thread until it runs, then becomes a user message", () => {
  const items = play([
    { type: "queued", id: "q1", text: "next" },
    { type: "tool", name: "browser_open", input: "{}" },
    { type: "done" },
    { type: "dequeued", id: "q1" },
    { type: "user", text: "next" },
  ]);
  expect(items.map((i) => i.kind)).toEqual(["tool", "user"]);
});

test("cancelling removes only that queued message", () => {
  const items = play([
    { type: "queued", id: "q1", text: "a" },
    { type: "queued", id: "q2", text: "b" },
    { type: "dequeued", id: "q1" },
  ]);
  expect(items).toEqual([{ kind: "queued", id: "q2", text: "b", mentions: undefined }]);
});

const task = (state: "running" | "done" | "failed", goal = "research X") =>
  ({ type: "task", taskId: "t1", goal, state, startedAt: 1 }) as const;

test("a task is one row that follows its state, and keeps its place in the thread", () => {
  const items = play([
    { type: "user", text: "research X" },
    task("running"),
    { type: "text_start" },
    { type: "delta", text: "On it." },
    task("done"),
  ]);
  expect(items).toEqual([
    { kind: "user", text: "research X", mentions: undefined },
    { kind: "task", taskId: "t1", goal: "research X", state: "done", status: undefined },
    { kind: "assistant", text: "On it." },
  ]);
});

test("a task's status line follows its status events, an empty one clears it, and it is dropped when the task ends", () => {
  const status = (text: string) => ({ type: "task_status", taskId: "t1", text }) as const;
  expect(play([task("running"), status("Searching")])[0]).toMatchObject({ status: "Searching" });
  expect(play([task("running"), status("Searching"), status("")])[0]).toMatchObject({
    status: undefined,
  });
  // A task event for a running task keeps its line, as when the task is resumed or its row is refreshed.
  expect(play([task("running"), status("Searching"), task("running")])[0]).toMatchObject({
    status: "Searching",
  });
  expect(play([task("running"), status("Searching"), task("failed")])[0]).toMatchObject({
    state: "failed",
    status: undefined,
  });
  // A status for a task the thread does not show changes nothing.
  expect(play([task("running"), { type: "task_status", taskId: "other", text: "x" }])).toEqual([
    { kind: "task", taskId: "t1", goal: "research X", state: "running", status: undefined },
  ]);
});

test("a report is a row of its own, after the task, naming the task's goal when the thread knows it", () => {
  const items = play([
    task("done", "pricing of X"),
    { type: "report", taskId: "t1", text: "$20 a month." },
    { type: "report", taskId: "unknown", text: "No task row." },
  ]);
  expect(items.slice(1)).toEqual([
    { kind: "report", taskId: "t1", text: "$20 a month.", task: "pricing of X" },
    { kind: "report", taskId: "unknown", text: "No task row.", task: undefined },
  ]);
});

test("a report that arrives while a message is queued stays before the queued message", () => {
  const items = play([
    { type: "queued", id: "q1", text: "next" },
    { type: "report", taskId: "t1", text: "Done." },
  ]);
  expect(items.map((i) => i.kind)).toEqual(["report", "queued"]);
});
