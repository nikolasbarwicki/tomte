// The root update helper (ADR-0014): `tomte-host apply-update`, run by tomte-update.service as root. It imports only the
// platform and the contract, like every module on the root path, so nothing of the host server runs with root's rights.
import { lstatSync, readFileSync } from "node:fs";

import { DEFAULT_CONF_PATH, parseUpdateConf, type UpdateConf } from "../platform/update-conf.ts";
import { runUpdate, type Deps } from "./apply.ts";
import { systemDeps } from "./system.ts";

export type { Deps } from "./apply.ts";
export type { UpdateConf } from "../platform/update-conf.ts";

/** The helper was started by, or configured by, someone who is not root. */
export class NotRoot extends Error {}

/** Reads the helper's configuration, which only `owner` may own and no one else may write. */
export function readUpdateConf(path: string, owner: number): UpdateConf {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== owner || (stat.mode & 0o022) !== 0)
    throw new NotRoot(
      `${path} must be a regular file owned by uid ${owner} that no one else can write`,
    );
  return parseUpdateConf(readFileSync(path, "utf8"));
}

export interface ApplyUpdateOptions {
  /** The user the process runs as; the helper refuses anything but `rootUid`. */
  uid: number;
  /** The uid that counts as root, and owns the configuration; 0 outside tests. */
  rootUid?: number;
  confPath?: string;
  /** Everything outside the process; the machine's own by default. */
  deps?: (conf: UpdateConf) => Deps;
}

/**
 * `apply-update`: refuses to run as anyone but root, takes its settings from the root-owned configuration (never from flags or
 * the environment), then handles the request the service user left, if any.
 */
export async function applyUpdate(o: ApplyUpdateOptions): Promise<void> {
  const root = o.rootUid ?? 0;
  if (o.uid !== root)
    throw new NotRoot("apply-update runs as root only (it is started by tomte-update.service)");
  const conf = readUpdateConf(o.confPath ?? DEFAULT_CONF_PATH, root);
  await runUpdate(conf, (o.deps ?? systemDeps)(conf));
}
