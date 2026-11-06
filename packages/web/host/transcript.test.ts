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
