import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Another host process is running on the data root. */
export class DataRootLocked extends Error {
  constructor(
    readonly dataRoot: string,
    readonly pid: number,
  ) {
    super(`data root ${dataRoot} is in use by the host running as pid ${pid}`);
  }
}

export interface DataRootLock {
  /** Frees the data root for the next host. Safe to call twice. */
  release(): void;
}

const LOCK_FILE = "host.lock";

/** Lock files this process holds. A lock file naming our own pid that is not in here was left by an earlier process that had the same pid, as happens in a restarted container. */
const held = new Set<string>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holderOf(lockPath: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return pid === process.pid && !held.has(lockPath) ? undefined : alive(pid) ? pid : undefined;
}

/**
 * Takes the exclusive lock on the data root, creating the directory if needed. The lock is a file holding the host's pid, created whole in one atomic step.
 * A lock file whose process is gone is stale and is replaced. Throws `DataRootLocked` when a live host holds the lock.
 */
export function acquireDataRootLock(dataRoot: string): DataRootLock {
  mkdirSync(dataRoot, { recursive: true });
  const lockPath = join(dataRoot, LOCK_FILE);
  const mine = `${lockPath}.${process.pid}.${Bun.randomUUIDv7()}`;
  writeFileSync(mine, String(process.pid));
  try {
    for (;;) {
      try {
        linkSync(mine, lockPath);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const pid = holderOf(lockPath);
      if (pid !== undefined) throw new DataRootLocked(dataRoot, pid);
      rmSync(lockPath, { force: true });
    }
  } finally {
    rmSync(mine, { force: true });
  }
  held.add(lockPath);
  return {
    release() {
      if (!held.delete(lockPath)) return;
      rmSync(lockPath, { force: true });
    },
  };
}
