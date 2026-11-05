import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
}

/** Every process on the machine with its parent and process group. POSIX `ps`; empty when `ps` is unavailable. */
function processTable(): Proc[] {
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((p) => p.length === 3 && p.every(Number.isInteger))
    .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
}

export function readPid(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** An engine daemon and everything under it. Chrome runs in its own process group, so the daemon's group alone does not reach it. */
export interface EngineTree {
  daemon: number;
  /** Chrome and its children, in no particular order. */
  descendants: Proc[];
}

export function engineTree(daemon: number): EngineTree {
  const table = processTable();
  const found = new Map<number, Proc>();
  let frontier = [daemon];
  while (frontier.length) {
    const next: number[] = [];
    for (const p of table) {
      if (frontier.includes(p.ppid) && !found.has(p.pid) && p.pid !== daemon) {
        found.set(p.pid, p);
        next.push(p.pid);
      }
    }
    frontier = next;
  }
  return { daemon, descendants: [...found.values()] };
}

/** The Chrome main process: the daemon's first child. Changes when Chrome crashes and the engine relaunches it. */
export function chromePid(daemon: number): number | undefined {
  return processTable().find((p) => p.ppid === daemon)?.pid;
}

const pidsOf = (t: EngineTree) => [t.daemon, ...t.descendants.map((p) => p.pid)];

/** Resolves true once every process of the tree has exited, false at the deadline. */
export async function waitForExit(tree: EngineTree, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pidsOf(tree).some(isAlive)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

/** SIGKILLs the daemon's process group, then each captured process's group and the process itself. */
export function killTree(tree: EngineTree): void {
  const groups = new Set([tree.daemon, ...tree.descendants.map((p) => p.pgid)]);
  for (const g of groups) if (g > 1) trySignal(-g);
  for (const pid of pidsOf(tree)) trySignal(pid);
}

function trySignal(target: number) {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // already gone
  }
}
