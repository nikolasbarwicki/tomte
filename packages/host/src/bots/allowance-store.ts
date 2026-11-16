import type { Database } from "bun:sqlite";

/** A tool the owner always allows for one bot, and when they said so. */
export type ToolAllowance = { tool: string; createdAt: number };

/** Stores the rule; saying it twice keeps the first date. */
export function allowTool(db: Database, botId: string, tool: string, at: number) {
  db.query(
    "INSERT INTO tool_allowances (bot_id, tool_name, created_at) VALUES (?, ?, ?) ON CONFLICT (bot_id, tool_name) DO NOTHING",
  ).run(botId, tool, at);
}

export function allowsTool(db: Database, botId: string, tool: string): boolean {
  return (
    db
      .query<{ one: number }, [string, string]>(
        "SELECT 1 AS one FROM tool_allowances WHERE bot_id = ? AND tool_name = ?",
      )
      .get(botId, tool) !== null
  );
}

/** The bot's rules, oldest first. */
export function listAllowances(db: Database, botId: string): ToolAllowance[] {
  return db
    .query<{ tool_name: string; created_at: number }, [string]>(
      "SELECT tool_name, created_at FROM tool_allowances WHERE bot_id = ? ORDER BY created_at, rowid",
    )
    .all(botId)
    .map((r) => ({ tool: r.tool_name, createdAt: r.created_at }));
}

/** Takes one rule back; false when the bot had none for the tool. */
export function removeAllowance(db: Database, botId: string, tool: string): boolean {
  return (
    db.query("DELETE FROM tool_allowances WHERE bot_id = ? AND tool_name = ?").run(botId, tool)
      .changes > 0
  );
}

export function deleteAllowances(db: Database, botId: string) {
  db.query("DELETE FROM tool_allowances WHERE bot_id = ?").run(botId);
}
