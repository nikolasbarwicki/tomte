import type { Database } from "bun:sqlite";

import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

/** What one turn used: the difference between the session's cumulative totals before and after it. `costUsd` is an estimate at API prices. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/**
 * Sees every result message of every thread; returns the turn's usage, or null when the turn's own share cannot be known. `botId` is
 * who owns the session, kept with the mark so deleting a bot can find every session it ran, whichever thread ran it.
 */
export interface UsageMeter {
  record(
    sessionId: string,
    result: SDKResultMessage,
    resumed: boolean,
    botId?: string,
  ): TurnUsage | null;
}

/** A failed turn still cost something; the run that ran it keeps that. */
export class TurnError extends Error {
  constructor(
    message: string,
    readonly usage: TurnUsage | null,
  ) {
    super(message);
    this.name = "TurnError";
  }
}

type MarkRow = {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};

/**
 * The SDK's `total_cost_usd` and `modelUsage` are cumulative over a session (a resumed session's first result already carries its
 * earlier turns), so a turn's usage is the difference from the last totals the host saw. `usage` on the result is the main loop only
 * and would disagree with the cost, so tokens are the sums of `modelUsage`.
 */
export function createUsageMeter(db: Database, now: () => number = Date.now): UsageMeter {
  const read = db.query<MarkRow, [string]>(
    `SELECT cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
     FROM session_usage_marks WHERE session_id = ?`,
  );
  const write = db.query(
    `INSERT INTO session_usage_marks
       (session_id, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at, bot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       cost_usd = excluded.cost_usd,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cache_read_tokens = excluded.cache_read_tokens,
       cache_creation_tokens = excluded.cache_creation_tokens,
       updated_at = excluded.updated_at,
       bot_id = COALESCE(excluded.bot_id, bot_id)`,
  );
  return {
    record(sessionId, result, resumed, botId) {
      const models = Object.values(result.modelUsage ?? {});
      const sum = (pick: (m: (typeof models)[number]) => number | undefined) =>
        models.reduce((n, m) => n + (pick(m) ?? 0), 0);
      const total: TurnUsage = {
        inputTokens: sum((m) => m.inputTokens),
        outputTokens: sum((m) => m.outputTokens),
        cacheReadTokens: sum((m) => m.cacheReadInputTokens),
        cacheCreationTokens: sum((m) => m.cacheCreationInputTokens),
        costUsd: result.total_cost_usd ?? 0,
      };
      const mark = read.get(sessionId);
      write.run(
        sessionId,
        total.costUsd,
        total.inputTokens,
        total.outputTokens,
        total.cacheReadTokens,
        total.cacheCreationTokens,
        now(),
        botId ?? null,
      );
      // A session the host has never seen: new, so it started from zero, or resumed, so its earlier cost is unknown.
      if (!mark) return resumed ? null : total;
      // A total below the mark means the session started over (`/clear`): count from zero.
      const reset =
        total.costUsd < mark.cost_usd ||
        total.inputTokens < mark.input_tokens ||
        total.outputTokens < mark.output_tokens ||
        total.cacheReadTokens < mark.cache_read_tokens ||
        total.cacheCreationTokens < mark.cache_creation_tokens;
      if (reset) return total;
      return {
        inputTokens: total.inputTokens - mark.input_tokens,
        outputTokens: total.outputTokens - mark.output_tokens,
        cacheReadTokens: total.cacheReadTokens - mark.cache_read_tokens,
        cacheCreationTokens: total.cacheCreationTokens - mark.cache_creation_tokens,
        costUsd: total.costUsd - mark.cost_usd,
      };
    },
  };
}

/**
 * Forgets the marks of a deleted bot's sessions, in one transaction: those saved with its id, and those of `sessionIds` saved without
 * one (written before the host kept it; see `sessionsOfBot`). Another bot's marks are never touched.
 */
export function deleteBotUsage(db: Database, botId: string, sessionIds: readonly string[]): void {
  const byBot = db.query("DELETE FROM session_usage_marks WHERE bot_id = ?");
  const bySession = db.query(
    "DELETE FROM session_usage_marks WHERE session_id = ? AND bot_id IS NULL",
  );
  db.transaction(() => {
    byBot.run(botId);
    for (const id of sessionIds) bySession.run(id);
  })();
}

/** The sessions the database ties to a bot besides its chat sessions: those of its routine runs and its double-loop tasks and reports. */
export function sessionsOfBot(db: Database, botId: string): string[] {
  return db
    .query<{ session_id: string }, [string, string, string]>(
      `SELECT rr.session_id FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id
         WHERE r.bot_id = ? AND rr.session_id IS NOT NULL
       UNION SELECT session_id FROM loop_tasks WHERE bot_id = ?
       UNION SELECT session_id FROM loop_events WHERE bot_id = ?`,
    )
    .all(botId, botId, botId)
    .map((r) => r.session_id);
}
