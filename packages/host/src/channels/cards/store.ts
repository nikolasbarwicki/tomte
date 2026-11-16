import type { Database } from "bun:sqlite";

import type { ItemKind } from "./types.ts";

/** One card a channel sent. */
interface CardRow {
  channel: string;
  itemKind: ItemKind;
  itemId: string;
  botId: string;
  messageRef: string;
  sentAt: number;
  closedAt: number | null;
}

type Row = {
  channel: string;
  item_kind: ItemKind;
  item_id: string;
  bot_id: string;
  message_ref: string;
  sent_at: number;
  closed_at: number | null;
};

const rowOf = (r: Row): CardRow => ({
  channel: r.channel,
  itemKind: r.item_kind,
  itemId: r.item_id,
  botId: r.bot_id,
  messageRef: r.message_ref,
  sentAt: r.sent_at,
  closedAt: r.closed_at,
});

const COLUMNS = "channel, item_kind, item_id, bot_id, message_ref, sent_at, closed_at";

/** The `channel_cards` table: which items each channel has a card for. */
export interface CardStore {
  /** The card of an item, open or closed. */
  find(channel: string, kind: ItemKind, id: string): CardRow | undefined;
  /** The card that is the message `ref`. */
  byRef(channel: string, ref: string): CardRow | undefined;
  /** Every card not closed yet, in the order it was sent. */
  open(): CardRow[];
  /** Records a card; false when the item already has one. */
  add(row: Omit<CardRow, "closedAt">): boolean;
  /** Marks a card closed; false when it was closed already, so an edit is made once. */
  close(channel: string, kind: ItemKind, id: string, at: number): boolean;
}

/** It reads and writes the database on every call and keeps no state of its own. */
export function createCardStore(db: Database): CardStore {
  const find = db.query<Row, [string, string, string]>(
    `SELECT ${COLUMNS} FROM channel_cards WHERE channel = ? AND item_kind = ? AND item_id = ?`,
  );
  const byRef = db.query<Row, [string, string]>(
    `SELECT ${COLUMNS} FROM channel_cards WHERE channel = ? AND message_ref = ?`,
  );
  const open = db.query<Row, []>(
    `SELECT ${COLUMNS} FROM channel_cards WHERE closed_at IS NULL ORDER BY sent_at, rowid`,
  );

  return {
    find: (channel: string, kind: ItemKind, id: string): CardRow | undefined => {
      const r = find.get(channel, kind, id);
      return r ? rowOf(r) : undefined;
    },
    byRef: (channel: string, ref: string): CardRow | undefined => {
      const r = byRef.get(channel, ref);
      return r ? rowOf(r) : undefined;
    },
    open: (): CardRow[] => open.all().map(rowOf),
    add(row: Omit<CardRow, "closedAt">): boolean {
      return (
        db
          .query(`INSERT OR IGNORE INTO channel_cards (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL)`)
          .run(row.channel, row.itemKind, row.itemId, row.botId, row.messageRef, row.sentAt)
          .changes > 0
      );
    },
    close(channel: string, kind: ItemKind, id: string, at: number): boolean {
      return (
        db
          .query(
            "UPDATE channel_cards SET closed_at = ? WHERE channel = ? AND item_kind = ? AND item_id = ? AND closed_at IS NULL",
          )
          .run(at, channel, kind, id).changes > 0
      );
    },
  };
}
