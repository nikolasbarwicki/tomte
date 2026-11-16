import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";

/** How long a link code stays usable after it is created. */
const CODE_TTL_MS = 10 * 60_000;

/** Failed attempts that invalidate every outstanding code of a channel. */
const MAX_FAILURES = 10;

export interface StoredLink {
  accountId: string;
  label: string;
  linkedAt: number;
}

const digest = (code: string) => createHash("sha256").update(code).digest();

/** The channel links and link codes. It reads and writes the database on every call and keeps no state of its own. */
export function createChannelStore(db: Database) {
  const exchange = db.transaction(
    (channel: string, code: string, account: { id: string; label: string }, at: number) => {
      const live = db
        .query<{ code_digest: Uint8Array }, [string, number]>(
          "SELECT code_digest FROM channel_link_codes WHERE channel = ? AND used_at IS NULL AND expires_at > ?",
        )
        .all(channel, at);
      const wanted = digest(code);
      // Every digest is compared, in constant time, so timing does not reveal a near match.
      let match: Uint8Array | undefined;
      for (const row of live)
        if (timingSafeEqual(row.code_digest, wanted)) match ??= row.code_digest;
      if (!match) {
        db.query("UPDATE channel_link_codes SET failures = failures + 1 WHERE channel = ?").run(
          channel,
        );
        db.query("DELETE FROM channel_link_codes WHERE channel = ? AND failures >= ?").run(
          channel,
          MAX_FAILURES,
        );
        return false;
      }
      db.query(
        "UPDATE channel_link_codes SET used_at = ? WHERE channel = ? AND code_digest = ?",
      ).run(at, channel, match);
      // Cards were sent to the earlier account's chat: another account starts with none, so every open item reaches it.
      db.query(
        "DELETE FROM channel_cards WHERE channel = ? AND (SELECT account_id FROM channel_links WHERE channel = ?) IS NOT ?",
      ).run(channel, channel, account.id);
      db.query(
        "INSERT OR REPLACE INTO channel_links (channel, account_id, label, linked_at) VALUES (?, ?, ?, ?)",
      ).run(channel, account.id, account.label, at);
      return true;
    },
  );

  return {
    /** Stores the digest of a new code for the channel and restarts the channel's failure count. */
    addCode(channel: string, code: string, at: number) {
      db.transaction(() => {
        db.query("DELETE FROM channel_link_codes WHERE channel = ? AND expires_at <= ?").run(
          channel,
          at,
        );
        db.query("UPDATE channel_link_codes SET failures = 0 WHERE channel = ?").run(channel);
        db.query(
          "INSERT INTO channel_link_codes (channel, code_digest, expires_at) VALUES (?, ?, ?)",
        ).run(channel, digest(code), at + CODE_TTL_MS);
      }).immediate();
    },

    /**
     * Exchanges a code for a link of the channel to `account`, replacing any earlier link; false when the code is unknown, used or expired.
     * Each false is a failed attempt, and the 10th since a code was last created deletes every code of the channel. A success does not reset the count.
     * One write transaction, so two exchanges of the same code cannot both succeed.
     */
    link: (channel: string, code: string, account: { id: string; label: string }, at: number) =>
      exchange.immediate(channel, code, account, at),

    linkOf(channel: string): StoredLink | undefined {
      const row = db
        .query<{ account_id: string; label: string; linked_at: number }, [string]>(
          "SELECT account_id, label, linked_at FROM channel_links WHERE channel = ?",
        )
        .get(channel);
      return row
        ? { accountId: row.account_id, label: row.label, linkedAt: row.linked_at }
        : undefined;
    },

    unlink(channel: string): boolean {
      // The cards belong to the chat that was linked; a later link starts again and sends every open item.
      db.query("DELETE FROM channel_cards WHERE channel = ?").run(channel);
      return db.query("DELETE FROM channel_links WHERE channel = ?").run(channel).changes > 0;
    },
  };
}
