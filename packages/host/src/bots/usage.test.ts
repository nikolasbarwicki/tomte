import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { migrate } from "../platform/db.ts";
import { createUsageMeter, deleteBotUsage, sessionsOfBot } from "./usage.ts";

const result = (cost: number) =>
  ({ total_cost_usd: cost, modelUsage: {} }) as unknown as SDKResultMessage;
const marks = (db: Database) =>
  db
    .query<{ session_id: string; bot_id: string | null }, []>(
      "SELECT session_id, bot_id FROM session_usage_marks ORDER BY session_id",
    )
    .all();

test("the meter keeps the bot a session belongs to, and a later turn without one does not forget it", () => {
  const db = migrate(new Database(":memory:"));
  const meter = createUsageMeter(db);
  meter.record("s1", result(1), false, "bot-a");
  meter.record("s1", result(2), true);
  expect(marks(db)).toEqual([{ session_id: "s1", bot_id: "bot-a" }]);
});

test("a mark from before bot ids is backfilled from the routine runs and loop rows that name its session", () => {
  const db = migrate(new Database(":memory:"));
  db.run(
    "INSERT INTO routines (id, bot_id, name, instruction, schedule, created_at, updated_at) VALUES ('r1', 'bot-a', 'n', 'i', '{}', 1, 1)",
  );
  db.run(
    "INSERT INTO routine_runs (id, routine_id, trigger, status, session_id, started_at) VALUES ('run1', 'r1', 'manual', 'succeeded', 'run-session', 1)",
  );
  const meter = createUsageMeter(db);
  for (const s of ["run-session", "chat-session"]) meter.record(s, result(1), false);
  // Put the database back to before the bot id existed, then migrate again.
  db.run("UPDATE session_usage_marks SET bot_id = NULL");
  db.run("PRAGMA user_version = 25");
  migrate(db);
  expect(marks(db)).toEqual([
    { session_id: "chat-session", bot_id: null },
    { session_id: "run-session", bot_id: "bot-a" },
  ]);
  expect(sessionsOfBot(db, "bot-a")).toEqual(["run-session"]);

  deleteBotUsage(db, "bot-a", ["chat-session"]);
  expect(marks(db)).toEqual([]);
});
