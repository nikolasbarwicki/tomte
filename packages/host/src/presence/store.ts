import type { Database } from "bun:sqlite";

export type PresenceRow = { lastActionAt: number; lastWarnedAt: number | null };

export function createPresenceStore(db: Database) {
  return {
    get(): PresenceRow | undefined {
      const r = db
        .query<{ last_action_at: number; last_warned_at: number | null }, []>(
          "SELECT last_action_at, last_warned_at FROM presence WHERE id = 1",
        )
        .get();
      return r ? { lastActionAt: r.last_action_at, lastWarnedAt: r.last_warned_at } : undefined;
    },

    /** Stores the owner's action at `at` and forgets the warning of the absence it ends. */
    act(at: number) {
      db.query(
        `INSERT INTO presence (id, last_action_at, last_warned_at) VALUES (1, ?, NULL)
         ON CONFLICT (id) DO UPDATE SET last_action_at = excluded.last_action_at, last_warned_at = NULL`,
      ).run(at);
    },

    warned(at: number) {
      db.query("UPDATE presence SET last_warned_at = ? WHERE id = 1").run(at);
    },
  };
}
