import type { Database } from "bun:sqlite";

import type { LastMessage } from "@claudebot/contract/events";

const PREVIEW_CHARS = 200;

export type Activity = { last: LastMessage | null; seenAt: number };

type ActivityRow = {
  last_from: LastMessage["from"] | null;
  last_text: string | null;
  last_at: number | null;
  seen_at: number;
};

export function getActivity(db: Database, botId: string): Activity | undefined {
  const r = db
    .query<ActivityRow, [string]>(
      "SELECT last_from, last_text, last_at, seen_at FROM bot_activity WHERE bot_id = ?",
    )
    .get(botId);
  if (!r) return undefined;
  const last =
    r.last_from && r.last_text !== null && r.last_at !== null
      ? { from: r.last_from, text: r.last_text, at: r.last_at }
      : null;
  return { last, seenAt: r.seen_at };
}

/** Records the bot's newest chat message; the stored text is a single-line preview without markdown markers. */
export function recordMessage(db: Database, botId: string, m: LastMessage) {
  const text = m.text
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*|__|`+|~~/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_CHARS);
  db.query(
    `INSERT INTO bot_activity (bot_id, last_from, last_text, last_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (bot_id) DO UPDATE SET last_from = excluded.last_from, last_text = excluded.last_text, last_at = excluded.last_at`,
  ).run(botId, m.from, text, m.at);
}

export function markSeen(db: Database, botId: string, at: number) {
  db.query(
    "INSERT INTO bot_activity (bot_id, seen_at) VALUES (?, ?) ON CONFLICT (bot_id) DO UPDATE SET seen_at = excluded.seen_at",
  ).run(botId, at);
}
