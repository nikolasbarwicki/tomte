import { expect, test } from "bun:test";

import { arrangeBots } from "./bot-order.ts";

const bots = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((b) => b.id);

test("placed bots follow the saved order, below every bot not placed yet", () => {
  expect(ids(arrangeBots(bots("new", "a", "b", "c"), ["c", "a"]))).toEqual(["new", "b", "c", "a"]);
});

test("bots not placed keep the order they came in", () => {
  expect(ids(arrangeBots(bots("x", "y", "z"), []))).toEqual(["x", "y", "z"]);
});

test("a saved id that names no bot is ignored", () => {
  expect(ids(arrangeBots(bots("a", "b"), ["gone", "b", "a"]))).toEqual(["b", "a"]);
});
