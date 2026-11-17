import { expect, test } from "bun:test";

import type { BotSummary } from "@tomte/contract/events";

import { applyEvent, initialHostState, type HostEvent, type HostState } from "./state.ts";

const play = (events: HostEvent[], from: HostState = opened("b")) =>
  events.reduce(applyEvent, from);
/** The host streams `botId`'s chat, which held `events`. */
const opened = (botId: string, events: HostEvent[] = [], from = initialHostState) =>
  applyEvent(from, { type: "chat", botId, events: events as never });
const chatOf = (s: HostState, botId = "b") => s.views[botId]!.chat!;
const bot = (id: string) => ({ id }) as BotSummary;

test("a chat event opens the bot with the chat it carries, replacing what the page had of it", () => {
  const s = play([
    { type: "user", text: "hi" },
    { type: "context", tokens: 1, max: 2, percentage: 50 },
  ]);
  const replayed = opened("b", [{ type: "user", text: "again" }, { type: "done" }], s);
  expect(replayed.openBotId).toBe("b");
  expect(chatOf(replayed)).toEqual({
    items: [{ kind: "user", text: "again", mentions: undefined }],
    busy: false,
    presence: "idle",
    context: undefined,
    rateLimits: {},
  });
});

test("going to another bot keeps the last bot's chat, and live events reach only the open bot", () => {
  const a = opened("a", [{ type: "user", text: "to a" }]);
  const b = play([{ type: "user", text: "to b" }], opened("b", [], a));
  expect(b.openBotId).toBe("b");
  expect(chatOf(b, "a").items).toEqual([{ kind: "user", text: "to a", mentions: undefined }]);
  expect(chatOf(b, "b").items).toEqual([{ kind: "user", text: "to b", mentions: undefined }]);
});

test("a bot the host never sent has no chat, and events before any chat change nothing", () => {
  expect(applyEvent(initialHostState, { type: "user", text: "hi" })).toBe(initialHostState);
  const s = play([{ type: "routines", botId: "c", routines: [] }]);
  expect(s.views.c?.chat).toBeUndefined();
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
  const busyAfter = (e: HostEvent) => chatOf(play([e])).busy;
  expect(busyAfter({ type: "user", text: "hi" })).toBe(true);
  expect(busyAfter({ type: "routine", name: "r", trigger: "manual" })).toBe(true);
  expect(busyAfter(handoff("received"))).toBe(true);
  expect(busyAfter(handoff("sent"))).toBe(false);
  expect(chatOf(play([{ type: "user", text: "hi" }, { type: "done" }])).busy).toBe(false);
  expect(
    chatOf(
      play([
        { type: "user", text: "hi" },
        { type: "error", message: "boom" },
      ]),
    ).busy,
  ).toBe(false);
  expect(
    chatOf(
      play([
        { type: "user", text: "hi" },
        { type: "delta", text: "a" },
      ]),
    ).busy,
  ).toBe(true);
});

test("chat events extend the transcript", () => {
  const s = play([
    { type: "user", text: "hi" },
    { type: "text_start" },
    { type: "delta", text: "yo" },
  ]);
  expect(chatOf(s).items).toEqual([
    { kind: "user", text: "hi", mentions: undefined },
    { kind: "assistant", text: "yo" },
  ]);
});

test("user memory is shared and bot memory belongs to the open bot", () => {
  const s = play([
    { type: "memory", scope: "user", text: "likes tea" },
    { type: "memory", scope: "bot", text: "be brief" },
    { type: "memory", scope: "user", text: "likes coffee" },
  ]);
  expect(s.userMemory).toBe("likes coffee");
  expect(s.views.b?.memory).toBe("be brief");
  expect(opened("c", [], s).views.c?.memory).toBe("");
});

test("a session event clears the context", () => {
  const withContext = play([{ type: "context", tokens: 10, max: 100, percentage: 10 }]);
  expect(chatOf(withContext).context?.tokens).toBe(10);
  const s = applyEvent(withContext, { type: "session" });
  expect(chatOf(s).context).toBeUndefined();
  expect(chatOf(s).items).toEqual([{ kind: "session" }]);
});

test("snapshot events replace their slice: routines and work by their bot, files for the open bot", () => {
  const bots = [bot("b")];
  const s = play([
    { type: "bots", bots },
    { type: "integrations", integrations: [] },
    { type: "routines", botId: "b", routines: [] },
    { type: "work", botId: "c", sources: [] },
    { type: "files", dir: "/d", files: [] },
  ]);
  expect(s.bots).toBe(bots);
  expect(s.views.b?.routines?.botId).toBe("b");
  expect(s.views.b?.work).toBeUndefined();
  expect(s.views.c?.work?.botId).toBe("c");
  expect(s.views.b?.files.dir).toBe("/d");
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
  expect(next.views).toBe(s.views);
});

test("a bots event leaves the views identical, and drops the view of a deleted bot", () => {
  const s = play([{ type: "user", text: "hi" }], opened("b", [], opened("gone")));
  expect(applyEvent(s, { type: "bots", bots: [bot("b"), bot("gone")] }).views).toBe(s.views);
  const after = applyEvent(s, { type: "bots", bots: [bot("b")] });
  expect(Object.keys(after.views)).toEqual(["b"]);
  expect(after.views.b).toBe(s.views.b);
});

test("a chat event leaves the other slices identical", () => {
  const s = play([
    { type: "integrations", integrations: [] },
    { type: "bots", bots: [bot("b")] },
  ]);
  const next = applyEvent(s, { type: "delta", text: "a" });
  expect(next.integrations).toBe(s.integrations);
  expect(next.bots).toBe(s.bots);
  expect(next.userMemory).toBe(s.userMemory);
  expect(next.views.b?.files).toBe(s.views.b?.files);
});

test("presence follows the host's events, never a turn, and a new chat event clears it", () => {
  const typing = play([{ type: "presence", state: "typing" }]);
  expect(chatOf(typing).presence).toBe("typing");
  expect(chatOf(typing).busy).toBe(false);
  expect(chatOf(typing).items).toEqual([]);

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
  expect(chatOf(talking).presence).toBe("typing");
  expect(chatOf(talking).items).toHaveLength(2);

  expect(chatOf(play([{ type: "presence", state: "working" }], talking)).presence).toBe("working");
  expect(chatOf(play([{ type: "presence", state: "idle" }], talking)).presence).toBe("idle");
  expect(chatOf(opened("b", [], talking)).presence).toBe("idle");
});

test("rate limits are kept per window, the newest report replacing the last, and a new chat event clears them while a new session keeps them", () => {
  const s = play([
    { type: "rate_limit", status: "allowed", window: "five_hour", utilization: 0.4 },
    { type: "rate_limit", status: "allowed_warning", window: "seven_day", utilization: 0.8 },
    { type: "rate_limit", status: "allowed_warning", window: "five_hour", utilization: 0.9 },
  ]);
  expect(Object.keys(chatOf(s).rateLimits)).toEqual(["five_hour", "seven_day"]);
  expect(chatOf(s).rateLimits.five_hour).toMatchObject({
    status: "allowed_warning",
    utilization: 0.9,
  });
  expect(chatOf(s).items).toEqual([]);
  expect(chatOf(play([{ type: "session" }], s)).rateLimits).toEqual(chatOf(s).rateLimits);
  expect(chatOf(opened("b", [], s)).rateLimits).toEqual({});
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
  expect(chatOf(s).busy).toBe(false);
  expect(chatOf(s).presence).toBe("working");
  expect(chatOf(s).items).toMatchObject([
    { kind: "task", taskId: "t1", status: "Reading", findings: ["X costs $20."] },
    { kind: "task", taskId: "q-1", state: "queued", after: "t1" },
  ]);
});
