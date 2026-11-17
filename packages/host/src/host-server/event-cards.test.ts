import { expect, test } from "bun:test";

import type { EventItem } from "../events/index.ts";
import { NO_REFS } from "./chats.ts";
import { createEventCards } from "./event-cards.ts";

const item = (over: Partial<EventItem> = {}): EventItem => ({
  id: "e1",
  botId: "b1",
  kind: "question",
  source: "auth-sso",
  title: "Which database?",
  options: [],
  receivedAt: 1,
  state: "open",
  ...over,
});

// A kind the contract may add later; the cast stands in for it.
const notice = "notice" as EventItem["kind"];

function source(items: EventItem[], dismiss: "closed" | "unchanged" | "unknown" = "closed") {
  const sent: unknown[][] = [];
  const cards = createEventCards({
    events: {
      item: (id) => items.find((i) => i.id === id),
      openItems: () => items.filter((i) => i.state === "open"),
      dismiss: () => dismiss,
    },
    chats: {
      send: async (...args) => {
        sent.push(args);
        return { outcome: "sent" };
      },
    },
  });
  return { cards, sent };
}

test("a kind the web UI has no actions for still gets a Dismiss button, and nothing else", () => {
  // The card cannot know the actions of a kind it has not heard of, so it offers the one thing every item has.
  const { cards } = source([item({ kind: notice })]);
  expect(cards.open()).toEqual([
    {
      id: "e1",
      botId: "b1",
      openedAt: 1,
      heading: "auth-sso · Which database?",
      buttons: [{ label: "Dismiss", arg: "d" }],
      reply: false,
      panel: "settings",
      section: "routines",
    },
  ]);
});

test("a notice takes no reply, and a question's card still opens the work panel", async () => {
  const { cards, sent } = source([item({ kind: notice }), item({ id: "e2" })]);
  expect(await cards.reply("e1", "yes")).toEqual({
    outcome: "refused",
    reason: "A notice takes no reply. Use Dismiss.",
  });
  expect(sent).toEqual([]);
  expect(cards.open()[1]).toMatchObject({ panel: "work" });
});

test("a press of a button no action has, and of an item that is gone or closed, is refused and sends nothing", async () => {
  const { cards, sent } = source([item({ kind: notice }), item({ id: "e2", state: "dismissed" })]);
  expect(await cards.press("e1", "0")).toEqual({
    outcome: "refused",
    reason: "that button is out of date",
  });
  expect(await cards.press("nope", "d")).toEqual({ outcome: "refused", reason: "no such item" });
  expect(await cards.press("e2", "d")).toEqual({
    outcome: "refused",
    reason: "that item is already handled",
  });
  expect(await cards.reply("e2", "yes")).toEqual({
    outcome: "refused",
    reason: "that item is already handled",
  });
  expect(sent).toEqual([]);
});

test("Dismiss on an item the events store no longer has open is refused", async () => {
  const { cards } = source([item()], "unknown");
  expect(await cards.press("e1", "d")).toEqual({
    outcome: "refused",
    reason: "that item is already handled",
  });
});

test("a reply answers with the item's heading in front, as the web draft does", async () => {
  const { cards, sent } = source([item()]);
  expect(await cards.reply("e1", "Postgres")).toEqual({ outcome: "sent" });
  expect(sent).toEqual([
    [
      "b1",
      "auth-sso · Which database?: Postgres",
      "auth-sso · Which database?: Postgres",
      NO_REFS,
      "e1",
      "Postgres",
    ],
  ]);
});
