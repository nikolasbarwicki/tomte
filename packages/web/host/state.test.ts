import { expect, test } from "bun:test";

import type { BotSummary } from "@claudebot/contract/events";

import { applyEvent, initialHostState, type HostEvent, type HostState } from "./state.ts";

const play = (events: HostEvent[], from: HostState = initialHostState) =>
  events.reduce(applyEvent, from);

test("reset sets the open bot and clears the chat", () => {
  const s = play([
    { type: "user", text: "hi" },
    { type: "context", tokens: 1, max: 2, percentage: 50 },
    { type: "reset", botId: "b2" },
  ]);
  expect(s.openBotId).toBe("b2");
  expect(s.chat).toEqual({
    items: [],
    busy: false,
    presence: "idle",
    context: undefined,
    rateLimits: {},
  });
});

test("busy turns on for user, update, routine and received handoffs, and off for done and error", () => {
  const handoff = (direction: "sent" | "received"): HostEvent => ({
    type: "handoff",
    direction,
    bot: "x",
    title: "t",
    status: "submitted",
    text: "",
  });
  const busyAfter = (e: HostEvent) => applyEvent(initialHostState, e).chat.busy;
  expect(busyAfter({ type: "user", text: "hi" })).toBe(true);
  expect(busyAfter({ type: "routine", name: "r", trigger: "manual" })).toBe(true);
  expect(busyAfter(handoff("received"))).toBe(true);
  expect(busyAfter(handoff("sent"))).toBe(false);
  expect(play([{ type: "user", text: "hi" }, { type: "done" }]).chat.busy).toBe(false);
  expect(
    play([
      { type: "user", text: "hi" },
      { type: "error", message: "boom" },
    ]).chat.busy,
  ).toBe(false);
  expect(
    play([
      { type: "user", text: "hi" },
      { type: "delta", text: "a" },
    ]).chat.busy,
  ).toBe(true);
});

test("chat events extend the transcript", () => {
  const s = play([
    { type: "user", text: "hi" },
    { type: "text_start" },
    { type: "delta", text: "yo" },
  ]);
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
  const info = {
    cwd: "/",
    cli: "claude",
    browser: { status: "unavailable", reason: "none" },
    pauseAfterAbsenceDays: 0,
  } as const;
  expect(applyEvent(s, { type: "host-info", info }).info).toBe(info);
});

test("public-info sets what the host can do, which stays undefined until then", () => {
  expect(initialHostState.publicInfo).toBeUndefined();
  const info = {
    version: "0.1.0",
    apiVersion: 1,
    mode: "remote",
    claude: "signed-in",
    capabilities: { reveal: false, headedBrowser: false, browserSandbox: true },
  } as const;
  const s = play([{ type: "user", text: "hi" }]);
  const next = applyEvent(s, { type: "public-info", info });
  expect(next.publicInfo).toBe(info);
  expect(next.chat).toBe(s.chat);
});

test("a bots event leaves the chat reference identical", () => {
  const s = play([{ type: "user", text: "hi" }]);
  expect(applyEvent(s, { type: "bots", bots: [] }).chat).toBe(s.chat);
});

test("a chat event leaves the other slices identical", () => {
  const s = play([
    { type: "integrations", integrations: [] },
    { type: "bots", bots: [] },
  ]);
  const next = applyEvent(s, { type: "delta", text: "a" });
  expect(next.integrations).toBe(s.integrations);
  expect(next.bots).toBe(s.bots);
  expect(next.memory).toBe(s.memory);
});

test("presence follows the host's events, never a turn, and a reset clears it", () => {
  const typing = play([{ type: "presence", state: "typing" }]);
  expect(typing.chat.presence).toBe("typing");
  expect(typing.chat.busy).toBe(false);
  expect(typing.chat.items).toEqual([]);

  // A double-loop bot's messages and replies leave the presence the host last announced alone.
  const talking = play(
    [
      { type: "user", text: "hi" },
      { type: "text_start" },
      { type: "delta", text: "hey" },
      { type: "done" },
    ],
    typing,
  );
  expect(talking.chat.presence).toBe("typing");
  expect(talking.chat.items).toHaveLength(2);

  expect(play([{ type: "presence", state: "working" }], talking).chat.presence).toBe("working");
  expect(play([{ type: "presence", state: "idle" }], talking).chat.presence).toBe("idle");
  expect(play([{ type: "reset", botId: "b2" }], talking).chat.presence).toBe("idle");
});

test("rate limits are kept per window, the newest report replacing the last, and a reset clears them while a new session keeps them", () => {
  const s = play([
    { type: "rate_limit", status: "allowed", window: "five_hour", utilization: 0.4 },
    { type: "rate_limit", status: "allowed_warning", window: "seven_day", utilization: 0.8 },
    { type: "rate_limit", status: "allowed_warning", window: "five_hour", utilization: 0.9 },
  ]);
  expect(Object.keys(s.chat.rateLimits)).toEqual(["five_hour", "seven_day"]);
  expect(s.chat.rateLimits.five_hour).toMatchObject({
    status: "allowed_warning",
    utilization: 0.9,
  });
  expect(s.chat.items).toEqual([]);
  expect(play([{ type: "session" }], s).chat.rateLimits).toEqual(s.chat.rateLimits);
  expect(play([{ type: "reset", botId: "b2" }], s).chat.rateLimits).toEqual({});
});

test("task events build the task rows without touching the turn or the presence, and findings arrive with the task", () => {
  const working = play([{ type: "presence", state: "working" }]);
  const s = play(
    [
      { type: "task", taskId: "t1", goal: "research X", state: "running", startedAt: 1 },
      { type: "task_status", taskId: "t1", text: "Reading" },
      {
        type: "task",
        taskId: "t1",
        goal: "research X",
        state: "running",
        startedAt: 1,
        findings: ["X costs $20."],
      },
      { type: "task", taskId: "q-1", goal: "next", state: "queued", startedAt: 2, after: "t1" },
    ],
    working,
  );
  expect(s.chat.busy).toBe(false);
  expect(s.chat.presence).toBe("working");
  expect(s.chat.items).toMatchObject([
    { kind: "task", taskId: "t1", status: "Reading", findings: ["X costs $20."] },
    { kind: "task", taskId: "q-1", state: "queued", after: "t1" },
  ]);
});
