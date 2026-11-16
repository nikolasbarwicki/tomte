import { expect, test } from "bun:test";

import { itemActions, type ActionableItem } from "./item-actions.ts";

const item = (kind: string, options: string[] = []): ActionableItem => ({
  kind,
  source: "claudebot · 04-notify",
  title: "waiting for the API key",
  options,
});

test("a blocked item's first button opens a draft that answers it; the second asks for status", () => {
  expect(itemActions(item("blocked"))).toEqual([
    { label: "Unblock…", draft: "claudebot · 04-notify · waiting for the API key: " },
    { label: "Status", message: "Status claudebot · 04-notify: waiting for the API key" },
  ]);
});

test("a question's options answer it as the chip does, and a draft button follows them", () => {
  expect(itemActions(item("question", ["Ship it", "Hold"]))).toEqual([
    {
      label: "Ship it",
      message: "claudebot · 04-notify · waiting for the API key: answer 'Ship it'",
      answer: "Ship it",
    },
    {
      label: "Hold",
      message: "claudebot · 04-notify · waiting for the API key: answer 'Hold'",
      answer: "Hold",
    },
    { label: "Other…", draft: "claudebot · 04-notify · waiting for the API key: " },
  ]);
  expect(itemActions(item("question")).map((a) => a.label)).toEqual(["Answer…"]);
});

test("failed, done and stopped items each offer their own buttons", () => {
  expect(itemActions(item("failed")).map((a) => a.label)).toEqual(["Retry", "Skip"]);
  expect(itemActions(item("done"))).toEqual([
    { label: "Review", message: "Prepare the landing brief for claudebot · 04-notify" },
  ]);
  expect(itemActions(item("stopped"))).toEqual([
    { label: "Status", message: "Status claudebot · 04-notify" },
  ]);
});

test("a kind this function does not know has no actions", () => {
  expect(itemActions(item("some-later-kind"))).toEqual([]);
});
