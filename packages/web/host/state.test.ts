import { expect, test } from "bun:test";
import type { BotSummary, Notice } from "@claudebot/contract/events";
import { applyEvent, initialHostState, type HostEvent, type HostState } from "./state.ts";

const play = (events: HostEvent[], from: HostState = initialHostState) => events.reduce(applyEvent, from);

test("reset sets the open bot and clears the chat", () => {
  const s = play([{ type: "user", text: "hi" }, { type: "context", tokens: 1, max: 2, percentage: 50 }, { type: "reset", botId: "b2" }]);
  expect(s.openBotId).toBe("b2");
  expect(s.chat).toEqual({ items: [], busy: false, context: undefined });
});

test("busy turns on for user, update, routine and received handoffs, and off for done and error", () => {
  const handoff = (direction: "sent" | "received"): HostEvent => ({ type: "handoff", direction, bot: "x", title: "t", status: "s", text: "" });
  const busyAfter = (e: HostEvent) => applyEvent(initialHostState, e).chat.busy;
  expect(busyAfter({ type: "user", text: "hi" })).toBe(true);
  expect(busyAfter({ type: "update", text: "u" })).toBe(true);
  expect(busyAfter({ type: "routine", name: "r", trigger: "manual" })).toBe(true);
  expect(busyAfter(handoff("received"))).toBe(true);
  expect(busyAfter(handoff("sent"))).toBe(false);
  expect(play([{ type: "user", text: "hi" }, { type: "done" }]).chat.busy).toBe(false);
  expect(play([{ type: "user", text: "hi" }, { type: "error", message: "boom" }]).chat.busy).toBe(false);
  expect(play([{ type: "user", text: "hi" }, { type: "delta", text: "a" }]).chat.busy).toBe(true);
});

test("chat events extend the transcript", () => {
  const s = play([{ type: "user", text: "hi" }, { type: "text_start" }, { type: "delta", text: "yo" }]);
  expect(s.chat.items).toEqual([
    { kind: "user", text: "hi", mentions: undefined },
    { kind: "assistant", text: "yo" },
  ]);
});

test("memory events merge by scope", () => {
  const s = play([
    { type: "memory", scope: "user", text: "likes tea" },
    { type: "memory", scope: "bot", text: "be brief" },
    { type: "memory", scope: "user", text: "likes coffee" },
  ]);
  expect(s.memory).toEqual({ user: "likes coffee", bot: "be brief" });
});

test("notices are newest first and capped at 50", () => {
  const s = play(Array.from({ length: 55 }, (_, i): Notice => ({ type: "notify", source: "test", title: `n${i}`, body: "", at: i })));
  expect(s.notices).toHaveLength(50);
  expect(s.notices[0]?.title).toBe("n54");
  expect(s.notices.at(-1)?.title).toBe("n5");
});

test("a session event clears the context", () => {
  const withContext = play([{ type: "context", tokens: 10, max: 100, percentage: 10 }]);
  expect(withContext.chat.context?.tokens).toBe(10);
  const s = applyEvent(withContext, { type: "session" });
  expect(s.chat.context).toBeUndefined();
  expect(s.chat.items).toEqual([{ kind: "session" }]);
});

test("snapshot events replace their slice and host-info sets the info", () => {
  const bots: BotSummary[] = [];
  const s = play([
    { type: "bots", bots },
    { type: "integrations", integrations: [] },
    { type: "credentials", credentials: [] },
    { type: "routines", botId: "b", routines: [] },
    { type: "files", dir: "/d", files: [] },
  ]);
  expect(s.bots).toBe(bots);
  expect(s.routines?.botId).toBe("b");
  expect(s.files.dir).toBe("/d");
  const info = { cwd: "/", cli: "claude", auth: "ok", browser: { status: "unavailable", reason: "none" } } as const;
  expect(applyEvent(s, { type: "host-info", info }).info).toBe(info);
});

test("a bots event leaves the chat reference identical", () => {
  const s = play([{ type: "user", text: "hi" }]);
  expect(applyEvent(s, { type: "bots", bots: [] }).chat).toBe(s.chat);
});

test("a chat event leaves the other slices identical", () => {
  const s = play([{ type: "integrations", integrations: [] }, { type: "bots", bots: [] }]);
  const next = applyEvent(s, { type: "delta", text: "a" });
  expect(next.integrations).toBe(s.integrations);
  expect(next.bots).toBe(s.bots);
  expect(next.memory).toBe(s.memory);
  expect(next.notices).toBe(s.notices);
});
