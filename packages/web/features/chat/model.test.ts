import { expect, test } from "bun:test";

import type { WorkEvent } from "@claudebot/contract/events";

import type { Item } from "@/host/transcript.ts";

import { itemActions, needsYouItems, needsYouRows, rowLabels } from "./model.ts";

const work = (kind: "question" | "blocked" | "failed"): WorkEvent => ({
  type: "work",
  botId: "b1",
  sources: [
    {
      id: "s1",
      label: "claudebot · 04-notify",
      status: "blocked",
      lastEventAt: 2,
      work: null,
      events: [
        { id: "e1", kind, title: "waiting for the API key", receivedAt: 2, state: "open" },
        { id: "e2", kind, title: "handled one", receivedAt: 1, state: "acted" },
      ],
    },
  ],
});

test("an open blocked report is a needs-you item, a handled one is not", () => {
  expect(needsYouItems(work("blocked"), "b1").map((i) => [i.id, i.kind])).toEqual([
    ["e1", "blocked"],
  ]);
});

test("a blocked item's first button opens a draft that answers it; the second asks for status", () => {
  const [item] = needsYouItems(work("blocked"), "b1");
  expect(itemActions(item!)).toEqual([
    { label: "Unblock…", draft: "claudebot · 04-notify · waiting for the API key: " },
    { label: "Status", message: "Status claudebot · 04-notify: waiting for the API key" },
  ]);
});

const approve: Item = { kind: "approve", id: "a1", tool: "Mail__send", reason: "", input: "{}" };
const takeover: Item = {
  kind: "wait",
  id: "w1",
  waitKind: "takeover",
  title: "Needs you",
  detail: "A CAPTCHA blocks the page",
  actions: [
    { id: "done", label: "Done" },
    { id: "cancel", label: "Cancel" },
  ],
};
const ask = (extra: Partial<Extract<Item, { kind: "ask" }>> = {}): Item => ({
  kind: "ask",
  id: "q1",
  question: "Which database?",
  options: ["Postgres", "SQLite"],
  ...extra,
});

test("the bar lists external items first, then unresolved request cards in the order they came", () => {
  const rows = needsYouRows(work("blocked"), "b1", [
    takeover,
    { kind: "assistant", text: "hi" },
    approve,
  ]);
  expect(
    rows.map((r) =>
      r.type === "event" ? `event:${r.item.id}` : `${r.request.kind}:${r.request.id}`,
    ),
  ).toEqual(["event:e1", "wait:w1", "approve:a1"]);
  expect(rowLabels(rows)).toEqual(["claudebot · 04-notify", "Takeover", "Approval"]);
});

test("a request row carries its card's own buttons", () => {
  const requests = needsYouRows(undefined, "b1", [takeover, approve, ask()]).flatMap((r) =>
    r.type === "request" ? [r.request] : [],
  );
  expect(requests.map((r) => r.actions)).toEqual([
    [
      { label: "Done", value: "done" },
      { label: "Cancel", value: "cancel" },
    ],
    [
      { label: "Allow", value: "allow" },
      { label: "Deny", value: "deny" },
    ],
    [
      { label: "Postgres", value: "Postgres" },
      { label: "SQLite", value: "SQLite" },
    ],
  ]);
  expect(requests[0]?.title).toBe("A CAPTCHA blocks the page");
});

test("answered, resolved and expired cards are not rows", () => {
  expect(
    needsYouRows(undefined, "b1", [
      { ...approve, answer: "allow" } as Item,
      { ...takeover, resolved: "Done" } as Item,
      ask({ expired: true }),
      ask({ id: "q2", answer: "SQLite" }),
    ]),
  ).toEqual([]);
});

test("a question about an open external item is that item's row, not a second one", () => {
  const linked = ask({ eventId: "e1" });
  expect(needsYouRows(work("question"), "b1", [linked]).map((r) => r.type)).toEqual(["event"]);
  // Once the item is handled the question is the only thing left to answer.
  expect(needsYouRows(undefined, "b1", [linked]).map((r) => r.type)).toEqual(["request"]);
});
