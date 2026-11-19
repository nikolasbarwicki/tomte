// The files the host and the root update helper exchange (ADR-0014). The host (a service user) writes a request into its own
// state directory and reads the result; the helper (root) reads the request and writes the result. Neither carries bytes, URLs
// or paths: the only thing the service user can ask for is a published release version, or its predecessor.
import { z } from "zod";

/** A release version without the leading `v`: `1.2.0` or `1.2.0-rc.1`. The helper builds a download URL from it, so nothing else is accepted. */
export const ReleaseVersion = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/);

/** What `tomte-host --version` prints: the host's version and the database schema it migrates to. */
export const BinaryVersion = z.object({
  version: ReleaseVersion,
  schemaVersion: z.number().int().positive(),
});
export type BinaryVersion = z.infer<typeof BinaryVersion>;

const RequestId = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);

/**
 * `request.json`: what the service user asks of the helper. `id` names the request in its result, and a request id is handled once.
 * A rollback may carry `restoreSnapshot`, the owner's explicit confirmation that the database copy taken before the current version
 * went in replaces the database, for when the previous binary cannot open it. It is a flag, never a path: the helper knows the one
 * snapshot from its own layout (`snapshotName` of the installed version).
 */
export const UpdateRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("apply"), id: RequestId, version: ReleaseVersion }).strict(),
  z
    .object({
      kind: z.literal("rollback"),
      id: RequestId,
      restoreSnapshot: z.literal(true).exactOptional(),
    })
    .strict(),
]);
export type UpdateRequest = z.infer<typeof UpdateRequest>;

const Finished = {
  requestId: z.string(),
  finishedAt: z.number(),
  /** The binary installed when the helper finished; absent when it could not be run. */
  running: BinaryVersion.optional(),
  /** The one previous binary the helper keeps, which a rollback restores; absent when there is none. */
  previous: BinaryVersion.optional(),
};

/**
 * `result.json`: how the helper handled the request named by `requestId`.
 * - `updated`: the target runs and passed the health gate; `from` is the version before.
 * - `unchanged`: the target was already installed; nothing was touched.
 * - `rolled-back`: a rollback request restored `version`, and the database snapshot too when `snapshotRestored`.
 * - `refused`: nothing was changed, `reason` says why (bad signature, download failure, no previous binary, older schema, a restore
 *   asked for that is not needed or has no snapshot).
 * - `reverted`: `version` did not pass the health gate for `reason`; the helper put `rolledBackTo` back, and the database
 *   snapshot too when `snapshotRestored`.
 * - `failed`: the helper could not get a healthy host back; the host needs a person.
 */
export const UpdateResult = z.discriminatedUnion("outcome", [
  z.object({
    ...Finished,
    outcome: z.literal("updated"),
    from: ReleaseVersion,
    version: ReleaseVersion,
  }),
  z.object({ ...Finished, outcome: z.literal("unchanged"), version: ReleaseVersion }),
  z.object({
    ...Finished,
    outcome: z.literal("rolled-back"),
    from: ReleaseVersion,
    version: ReleaseVersion,
    snapshotRestored: z.boolean(),
  }),
  z.object({ ...Finished, outcome: z.literal("refused"), reason: z.string() }),
  z.object({
    ...Finished,
    outcome: z.literal("reverted"),
    version: ReleaseVersion,
    reason: z.string(),
    rolledBackTo: ReleaseVersion,
    snapshotRestored: z.boolean(),
  }),
  z.object({ ...Finished, outcome: z.literal("failed"), reason: z.string() }),
]);
export type UpdateResult = z.infer<typeof UpdateResult>;

/** Where the host and the helper meet, relative to the data root. */
export const UPDATES_DIR = "updates";
export const REQUEST_FILE = "request.json";
export const RESULT_FILE = "result.json";

/** The database snapshot taken before updating to `version`, in `UPDATES_DIR`; an automatic rollback restores it, and so does a confirmed manual one. */
export const snapshotName = (version: string) => `pre-${version}.db`;

/**
 * What the owner (or a page) asks of the host's own update, the one input of `Upkeep.run`:
 * - `check`: ask the release feed now.
 * - `apply`: update to the version the status offers (`available`), or to the one it names as `skipped` (a release the owner rolled back
 *   from, which only an explicit `apply` installs). `idle` closes the host to new turns and waits for running work to finish;
 *   `now` does not wait, and whatever runs is interrupted (and never run again). `now` also ends the wait of a drain already under
 *   way, an update's or a rollback's.
 * - `rollback`: go back to the version the status offers (`rollbackTo`, or `restoreTo`), through the same drain and helper as an
 *   update. `restoreSnapshot` is the explicit confirmation that the database is replaced by the copy taken before the update, losing
 *   everything since; it must be true exactly when the status offers `restoreTo`, and a request that disagrees is refused untouched.
 * - `cancel`: end a wait that has not reached the helper, reopening the host; or acknowledge a failed update or rollback.
 * - `auto`: turn applying an available update when idle on or off.
 */
export const UpdateAction = z.discriminatedUnion("op", [
  z.object({ op: z.literal("check") }),
  z.object({ op: z.literal("apply"), when: z.enum(["idle", "now"]) }),
  z.object({
    op: z.literal("rollback"),
    when: z.enum(["idle", "now"]),
    restoreSnapshot: z.boolean(),
  }),
  z.object({ op: z.literal("cancel") }),
  z.object({ op: z.literal("auto"), enabled: z.boolean() }),
]);
export type UpdateAction = z.infer<typeof UpdateAction>;

/** What a refused user action says while the host drains for an update: a message, a manual routine run. */
export const UPDATING = "Updating, back in a minute";
