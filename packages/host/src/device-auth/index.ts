import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { LAUNCH_DEVICE_NAME, LaunchToken } from "@claudebot/contract/sidecar";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_LENGTH = 12;
const GROUP = 4;

/** How long a pairing code stays usable after it is created. */
const CODE_TTL_MS = 10 * 60_000;

/** Failed exchanges that invalidate every outstanding pairing code. */
const MAX_FAILURES = 10;

const digest = (secret: string) => createHash("sha256").update(secret).digest();

/** Every case, separator and stray space is accepted when a person types a code back. */
const normalize = (code: string) => code.replace(/[^a-z2-7]/gi, "").toUpperCase();

/** Every digest is compared, in constant time, so timing does not reveal a near match. */
function findDigest<T extends { digest: Uint8Array }>(rows: T[], wanted: Buffer): T | undefined {
  let found: T | undefined;
  for (const row of rows) if (timingSafeEqual(row.digest, wanted)) found ??= row;
  return found;
}

/** A device's last-seen time moves forward at most this often, so a busy page does not write the database on every request. */
const LAST_SEEN_INTERVAL_MS = 60_000;

interface PairedDevice {
  deviceId: string;
  /** The device token, 32 random bytes as base64url. The host keeps only its digest, so this is the only time it is visible. */
  token: string;
}

/** A paired device as the Devices page lists it. */
interface DeviceSummary {
  id: string;
  name: string;
  createdAt: number;
  /** When the device last made an authenticated request, to within `LAST_SEEN_INTERVAL_MS`; null when it never has. */
  lastSeenAt: number | null;
}

export interface DeviceAuth {
  /**
   * A new pairing code: 12 base32 characters in groups of four, such as `ABCD-EFGH-IJKL`. Only its digest is stored.
   * It works once and for 10 minutes. Creating a code also restarts the failed-exchange count, so a lockout lasts only until the user creates the next code.
   */
  createPairingCode(): string;
  /**
   * Exchanges a pairing code for a new device named `name`; undefined when the code is unknown, already used or expired.
   * Each undefined answer is a failed attempt. The 10th failure since a code was last created deletes every outstanding code. A success does not reset the count: only a new code does.
   */
  pair(code: string, name: string): PairedDevice | undefined;
  /** The id of the device a token belongs to, which also records the device's activity; undefined for an unknown token. */
  authenticate(token: string): string | undefined;
  /**
   * Registers a desktop sidecar's launch token as the device "This computer", replacing the device an earlier sidecar run registered, in one write transaction.
   * The earlier one is found by a stored marker, never by name, so a paired device with the same name stays. Throws when the token is not a `LaunchToken`.
   */
  registerLaunchDevice(token: string): void;
  /** Every paired device, oldest first. */
  list(): DeviceSummary[];
  /** Deletes the device, so its token stops working; false when there is no such device. */
  revoke(id: string): boolean;
}

/** Devices and pairing codes. It reads and writes the database on every call and keeps no state of its own, so a second instance on the same database (the `host pair` subcommand) works next to a running host. `now` is the clock, in epoch milliseconds. */
export function createDeviceAuth(deps: { db: Database; now?: () => number }): DeviceAuth {
  const { db } = deps;
  const now = deps.now ?? Date.now;

  /** Runs as one write transaction, so two exchanges of the same code cannot both succeed, in this process or another. */
  const exchange = db.transaction((code: string, name: string): PairedDevice | undefined => {
    const at = now();
    const live = db
      .query<{ code_digest: Uint8Array }, [number]>(
        "SELECT code_digest FROM pairing_codes WHERE used_at IS NULL AND expires_at > ?",
      )
      .all(at)
      .map((r) => ({ digest: r.code_digest }));
    const match = findDigest(live, digest(normalize(code)));
    if (!match) {
      const { failures } = db
        .query<{ failures: number }, []>(
          "INSERT INTO pairing_failures (id, failures) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET failures = failures + 1 RETURNING failures",
        )
        .get()!;
      if (failures >= MAX_FAILURES) {
        db.run("DELETE FROM pairing_codes");
        db.run("DELETE FROM pairing_failures");
      }
      return undefined;
    }
    db.query("UPDATE pairing_codes SET used_at = ? WHERE code_digest = ?").run(at, match.digest);
    const token = randomBytes(32).toString("base64url");
    const deviceId = randomUUID();
    db.query("INSERT INTO devices (id, name, token_digest, created_at) VALUES (?, ?, ?, ?)").run(
      deviceId,
      name,
      digest(token),
      at,
    );
    return { deviceId, token };
  });

  return {
    createPairingCode() {
      const bytes = randomBytes(CODE_LENGTH);
      // 256 is a multiple of 32, so masking a byte to five bits picks each character evenly.
      const code = Array.from(bytes, (b) => BASE32[b & 31]).join("");
      const at = now();
      db.transaction(() => {
        db.query("DELETE FROM pairing_codes WHERE expires_at <= ?").run(at);
        db.run("DELETE FROM pairing_failures");
        db.query("INSERT INTO pairing_codes (code_digest, expires_at) VALUES (?, ?)").run(
          digest(code),
          at + CODE_TTL_MS,
        );
      }).immediate();
      return code.match(new RegExp(`.{${GROUP}}`, "g"))!.join("-");
    },

    pair: (code, name) => exchange.immediate(code, name),

    authenticate(token) {
      const rows = db
        .query<{ id: string; token_digest: Uint8Array; last_seen_at: number | null }, []>(
          "SELECT id, token_digest, last_seen_at FROM devices",
        )
        .all()
        .map((r) => ({ id: r.id, digest: r.token_digest, lastSeenAt: r.last_seen_at }));
      const device = findDigest(rows, digest(token));
      if (!device) return undefined;
      const at = now();
      if (device.lastSeenAt === null || at - device.lastSeenAt >= LAST_SEEN_INTERVAL_MS)
        db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, device.id);
      return device.id;
    },

    list() {
      return db
        .query<{ id: string; name: string; created_at: number; last_seen_at: number | null }, []>(
          "SELECT id, name, created_at, last_seen_at FROM devices ORDER BY created_at, rowid",
        )
        .all()
        .map((r) => ({
          id: r.id,
          name: r.name,
          createdAt: r.created_at,
          lastSeenAt: r.last_seen_at,
        }));
    },

    revoke(id) {
      return db.query("DELETE FROM devices WHERE id = ?").run(id).changes > 0;
    },

    registerLaunchDevice(token) {
      const launchToken = LaunchToken.parse(token);
      db.transaction(() => {
        db.run("DELETE FROM devices WHERE launch = 1");
        db.query(
          "INSERT INTO devices (id, name, token_digest, created_at, launch) VALUES (?, ?, ?, ?, 1)",
        ).run(randomUUID(), LAUNCH_DEVICE_NAME, digest(launchToken), now());
      }).immediate();
    },
  };
}
