import { expect, test } from "bun:test";

import type { WorkEvent } from "@claudebot/contract/events";

import { itemActions, needsYouItems } from "./model.ts";

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
