// The host's side of the files it shares with the root update helper (ADR-0014), plus the little state Upkeep keeps of its own in the
// same directory. Everything here is one small file written whole, through a rename, so a reader never sees half of it.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  REQUEST_FILE,
  RESULT_FILE,
  UPDATES_DIR,
  ReleaseVersion,
  UpdateRequest,
  UpdateResult,
} from "@tomte/contract/update";
import { z } from "zod";

const STATE_FILE = "upkeep.json";

/**
 * What survives a restart: whether updates apply by themselves, the release the host rolled back from (`skipped`, a version and
 * nothing else), and the request the helper has not answered (or answered with a failure the owner has not acknowledged).
 */
const UpkeepState = z.object({
  autoUpdate: z.boolean().default(false),
  skipped: ReleaseVersion.exactOptional(),
  pending: z
    .object({ id: z.string(), version: z.string(), rollback: z.literal(true).exactOptional() })
    .exactOptional(),
});
type UpkeepState = z.infer<typeof UpkeepState>;

export interface UpdateRequests {
  /** The directory the helper and the host meet in, `<dataRoot>/updates`. */
  dir: string;
  state(): UpkeepState;
  saveState(state: UpkeepState): void;
  /** Hands the request to the helper: its path unit starts the helper once the file exists. */
  request(request: UpdateRequest): void;
  /** Deletes every database snapshot except `keep` (a file name): only the latest one is the restore point. */
  pruneSnapshots(keep: string): void;
  /** When the snapshot `name` was taken (epoch milliseconds); undefined when there is none, or it is not a regular file. */
  snapshotTime(name: string): number | undefined;
  /** The helper's latest result; undefined when it has written none (or one that does not parse). */
  result(): UpdateResult | undefined;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeWhole(dir: string, name: string, value: unknown) {
  mkdirSync(dir, { recursive: true });
  const partial = join(dir, `.${name}.partial`);
  writeFileSync(partial, JSON.stringify(value));
  renameSync(partial, join(dir, name));
}

export function createUpdateRequests(dataRoot: string): UpdateRequests {
  const dir = join(dataRoot, UPDATES_DIR);
  return {
    dir,
    state: () =>
      UpkeepState.safeParse(readJson(join(dir, STATE_FILE))).data ?? UpkeepState.parse({}),
    saveState: (state) => writeWhole(dir, STATE_FILE, state),
    request: (request) => writeWhole(dir, REQUEST_FILE, UpdateRequest.parse(request)),
    pruneSnapshots(keep) {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir))
        if (/^pre-.*\.db$/.test(name) && name !== keep) rmSync(join(dir, name), { force: true });
    },
    snapshotTime(name) {
      try {
        const stat = lstatSync(join(dir, name));
        return stat.isFile() ? stat.mtimeMs : undefined;
      } catch {
        return undefined;
      }
    },
    result: () => UpdateResult.safeParse(readJson(join(dir, RESULT_FILE))).data,
  };
}
