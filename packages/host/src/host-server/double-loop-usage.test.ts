import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setChatMode } from "../bots/index.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "double-loop-usage-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
});
afterEach(async () => {
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

type Mark = { cost_usd: number; input_tokens: number; output_tokens: number };
type Run = {
  status: string;
  sessionId: string | null;
  costUsd: number | null;
  usage: { inputTokens: number; outputTokens: number } | null;
};

const markOf = (sessionId: string) =>
  host.db
    .query<Mark, [string]>(
      "SELECT cost_usd, input_tokens, output_tokens FROM session_usage_marks WHERE session_id = ?",
    )
    .get(sessionId);

/** A double-loop bot with a routine, plus a second bot so a chat is open; the front's session id is the bot's id. */
async function setup() {
  const botId = host.createBot("Planner");
  setChatMode(host.dataRoot, botId, "double_loop");
  const other = host.createBot("Other");
  const created = await host.ui("/api/routines/create", {
    botId,
    name: "nightly",
    instruction: "do the thing",
    schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
  });
  const routineId = ((await created.json()) as { id: string }).id;
  expect((await host.ui("/api/open", { botId })).status).toBe(200);
  return { botId, other, routineId };
}

/** One chat message to the front; returns once its turn has ended and the front is idle again. */
async function chat(botId: string, text: string) {
  const before = host.messagesOf(botId).length;
  expect((await host.ui("/api/send", { text })).status).toBe(200);
  await host.until(() => host.messagesOf(botId).length === before + 1);
  await host.until(() => !host.server.isWorking(botId));
}

const runs = async (routineId: string) =>
  (await (await host.ui("/api/routines/runs", { id: routineId })).json()) as Run[];

async function runOnce(routineId: string, ended = 1) {
  expect((await host.ui("/api/routines/run", { id: routineId })).status).toBe(200);
  for (let i = 0; i < 200; i++) {
    if ((await runs(routineId)).filter((r) => r.status !== "running").length === ended) break;
    await Bun.sleep(25);
  }
  const [run] = await runs(routineId);
  expect(run?.status).not.toBe("running");
  return run!;
}

test("front chat turns keep the front session's mark at the CLI's running totals, a failed turn included", async () => {
  const { botId } = await setup();

  host.setUsage({ cost: 0.5, input: 1000, output: 100 });
  await chat(botId, "hello");
  await host.until(() => markOf(botId)?.cost_usd === 0.5);
  expect(markOf(botId)).toEqual({ cost_usd: 0.5, input_tokens: 1000, output_tokens: 100 });

  host.setUsage({ cost: 0.9, input: 1800, output: 190 });
  await chat(botId, "and again");
  await host.until(() => markOf(botId)?.cost_usd === 0.9);
  expect(markOf(botId)).toEqual({ cost_usd: 0.9, input_tokens: 1800, output_tokens: 190 });

  // The turn failed but still cost something.
  host.setUsage({ cost: 1.1, input: 2100, output: 210, error: "the model gave up" });
  await chat(botId, "once more");
  await host.until(() => markOf(botId)?.cost_usd === 1.1);
  expect(markOf(botId)).toEqual({ cost_usd: 1.1, input_tokens: 2100, output_tokens: 210 });
});

test("a double-loop routine run after front chat turns is charged only its own usage, in a session of its own", async () => {
  const { botId, routineId } = await setup();

  host.setUsage({ cost: 2, input: 9000, output: 900 });
  await chat(botId, "hello");
  await host.until(() => markOf(botId)?.cost_usd === 2);

  // A run never shares the front's session: it gets a fresh one, whose totals start at zero.
  host.setUsage({ cost: 0.3, input: 500, output: 50 });
  const first = await runOnce(routineId);
  expect(first.status).toBe("succeeded");
  const runSession = first.sessionId;
  expect(runSession).not.toBeNull();
  expect(runSession).not.toBe(botId);
  expect(first.costUsd).toBeCloseTo(0.3);
  expect(first.usage).toMatchObject({ inputTokens: 500, outputTokens: 50 });
  expect(markOf(botId)).toEqual({ cost_usd: 2, input_tokens: 9000, output_tokens: 900 });
  expect(markOf(runSession!)).toEqual({ cost_usd: 0.3, input_tokens: 500, output_tokens: 50 });

  // The front goes on after the run; its mark moves on its own and the run's stays.
  host.setUsage({ cost: 2.4, input: 9800, output: 980 });
  await chat(botId, "how did that go?");
  await host.until(() => markOf(botId)?.cost_usd === 2.4);
  expect(markOf(runSession!)).toEqual({ cost_usd: 0.3, input_tokens: 500, output_tokens: 50 });

  const second = await runOnce(routineId, 2);
  expect(second.sessionId).not.toBe(runSession);
  expect(second.sessionId).not.toBe(botId);
});

test("the front's mark and its runs' marks carry the bot, and deleting the bot removes them", async () => {
  const { botId, other, routineId } = await setup();
  const owners = () =>
    host.db
      .query<{ session_id: string; bot_id: string | null }, []>(
        "SELECT session_id, bot_id FROM session_usage_marks ORDER BY session_id",
      )
      .all();

  host.setUsage({ cost: 0.5, input: 1000, output: 100 });
  await chat(botId, "hello");
  const run = await runOnce(routineId);
  expect(owners()).toEqual(
    [botId, run.sessionId!].sort().map((session_id) => ({ session_id, bot_id: botId })),
  );

  expect((await host.ui("/api/open", { botId: other })).status).toBe(200);
  await host.until(() => !host.server.isWorking(botId));
  expect((await host.ui("/api/bots/delete", { botId })).status).toBe(200);
  expect(owners()).toEqual([]);
});
