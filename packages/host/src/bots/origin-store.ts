import type { Database } from "bun:sqlite";

/** Records that the owner's latest message to the bot came from `origin` (`web`, or a channel's kind such as `telegram`), now. */
export function setOrigin(db: Database, botId: string, origin: string, at: number) {
  db.query(
    `INSERT INTO chat_origins (bot_id, origin, set_at) VALUES (?, ?, ?)
     ON CONFLICT (bot_id) DO UPDATE SET origin = excluded.origin, set_at = excluded.set_at`,
  ).run(botId, origin, at);
}

/** Where the owner's latest message to the bot came from; undefined when the owner never wrote to it (or the host never recorded it). */
export function getOrigin(db: Database, botId: string): string | undefined {
  return db
    .query<{ origin: string }, [string]>("SELECT origin FROM chat_origins WHERE bot_id = ?")
    .get(botId)?.origin;
}

export function deleteOrigin(db: Database, botId: string) {
  db.query("DELETE FROM chat_origins WHERE bot_id = ?").run(botId);
}
