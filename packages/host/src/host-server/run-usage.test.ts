import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSession } from "../testing/session-file.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

type Run = {
  id: string;
  status: string;
  error: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  } | null;
  costUsd: number | null;
};

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "run-usage-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
});
afterEach(async () => {
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

/** A bot with a routine, and a second bot so a chat is always open: the first bot's chat is open only when `chatHosted`. */
async function setup(chatHosted: boolean) {
  const botId = host.createBot("Planner");
  const other = host.createBot("Other");
  const created = await host.ui("/api/routines/create", {
    botId,
    name: "nightly",
    instruction: "do the thing",
    schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
  });
  const routineId = ((await created.json()) as { id: string }).id;
  expect((await host.ui("/api/open", { botId: chatHosted ? botId : other })).status).toBe(200);
  return { botId, routineId };
}

const runsOf = async (routineId: string) =>
  (await (await host.ui("/api/routines/runs", { id: routineId })).json()) as Run[];

/** Starts a test run and waits for it to end; returns it as the Routines panel lists it. */
async function runOnce(routineId: string, ended = 1) {
  expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
  for (let i = 0; i < 200; i++) {
    const runs = await runsOf(routineId);
    if (runs.filter((r) => r.status !== "running").length === ended) break;
    await Bun.sleep(25);
  }
  const [run] = await runsOf(routineId);
  expect(run?.status).not.toBe("running");
  return run!;
}

describe.each([
  ["chat-hosted", true],
  ["headless", false],
])("%s routine runs", (_label, chatHosted) => {
  test("two runs in one session each show their own cost, not the session's running total", async () => {
    const { routineId } = await setup(chatHosted);

    host.setUsage({ cost: 0.5, input: 1000, output: 100, cacheRead: 5000, cacheCreation: 200 });
    const first = await runOnce(routineId);
    expect(first.status).toBe("succeeded");
    expect(first.costUsd).toBeCloseTo(0.5);
    expect(first.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 5000,
      cacheCreationTokens: 200,
    });

    // The CLI reports the session's total: the first run's turn plus the second's.
    host.setUsage({ cost: 0.8, input: 1500, output: 160, cacheRead: 5400, cacheCreation: 200 });
    const second = await runOnce(routineId, 2);
    expect(second.costUsd).toBeCloseTo(0.3);
    expect(second.usage).toEqual({
      inputTokens: 500,
      outputTokens: 60,
      cacheReadTokens: 400,
      cacheCreationTokens: 0,
    });
  });

  test("a total below the last one, as after /clear, is the new run's own and never negative", async () => {
    const { routineId } = await setup(chatHosted);

    host.setUsage({ cost: 2, input: 9000, output: 900 });
    expect((await runOnce(routineId)).costUsd).toBeCloseTo(2);

    host.setUsage({ cost: 0.4, input: 300, output: 30 });
    const after = await runOnce(routineId, 2);
    expect(after.costUsd).toBeCloseTo(0.4);
    expect(after.usage).toMatchObject({ inputTokens: 300, outputTokens: 30 });
  });

  test("a failed turn keeps what it cost, on a failed run", async () => {
    const { routineId } = await setup(chatHosted);

    host.setUsage({ cost: 0.7, input: 700, output: 70, error: "the model gave up" });
    const failed = await runOnce(routineId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("the model gave up");
    expect(failed.costUsd).toBeCloseTo(0.7);
    expect(failed.usage).toMatchObject({ inputTokens: 700, outputTokens: 70 });
  });
});

test("a chat turn between two runs is not charged to the second", async () => {
  const { botId, routineId } = await setup(true);

  host.setUsage({ cost: 0.5, input: 1000, output: 100 });
  expect((await runOnce(routineId)).costUsd).toBeCloseTo(0.5);

  // The owner chats with the bot in the same session: 0.4 more.
  const messages = host.messagesOf(botId).length;
  host.setUsage({ cost: 0.9, input: 1800, output: 190 });
  expect((await host.ui("/api/send", { text: "how did that go?" })).status).toBe(200);
  await host.until(() => host.messagesOf(botId).length === messages + 1);
  await host.until(() => !host.server.isWorking(botId));

  host.setUsage({ cost: 1.0, input: 2000, output: 200 });
  const second = await runOnce(routineId, 2);
  expect(second.costUsd).toBeCloseTo(0.1);
  expect(second.usage).toMatchObject({ inputTokens: 200, outputTokens: 10 });
});

test("a resumed session the host has no mark for gives an unknown first cost and exact later ones", async () => {
  const { botId, routineId } = await setup(false);
  // The session exists from before this host kept marks: its first result already carries its earlier turns.
  writeSession(host, botId, [
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello" },
  ]);

  host.setUsage({ cost: 3, input: 30_000, output: 3000 });
  const first = await runOnce(routineId);
  expect(first.status).toBe("succeeded");
  expect(first.costUsd).toBeNull();
  expect(first.usage).toBeNull();

  host.setUsage({ cost: 3.25, input: 31_000, output: 3100 });
  const second = await runOnce(routineId, 2);
  expect(second.costUsd).toBeCloseTo(0.25);
  expect(second.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
});
