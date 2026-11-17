// What the desktop packaging and smoke scripts need to know about running processes, so that they never replace or kill
// an app that someone is using: the `ps` table, and which rows lie under a path.
export interface ProcessRow {
  pid: number;
  ppid: number;
  tty: string;
  command: string;
}

/** The rows of `ps -axo pid=,ppid=,tty=,command=` output. */
export function parseProcessTable(output: string): ProcessRow[] {
  return output.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3]!, command: m[4]! }] : [];
  });
}

export function processes(): ProcessRow[] {
  return parseProcessTable(
    Bun.spawnSync(["ps", "-axo", "pid=,ppid=,tty=,command="]).stdout.toString(),
  );
}

/** The rows whose command line names `path` or something inside it (a bundle's executable, its helpers, its resources), not a sibling such as `path-2`. */
export function processesUnder(path: string, rows: ProcessRow[]): ProcessRow[] {
  const escaped = path.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const under = new RegExp(`(?<![^\\s=])${escaped}(?:/|\\s|$)`);
  return rows.filter((p) => under.test(p.command));
}

/** `rows` without `pid` and its ancestors. A script's own command line (and its `bun run` parent's) may name the app it works on, and it must never count that, or kill it, as a leftover. */
export function outsideLineage(rows: ProcessRow[], pid: number): ProcessRow[] {
  const parents = new Map(rows.map((p) => [p.pid, p.ppid]));
  const lineage = new Set<number>();
  let at: number | undefined = pid;
  while (at !== undefined && at > 0 && !lineage.has(at)) {
    lineage.add(at);
    at = parents.get(at);
  }
  return rows.filter((p) => !lineage.has(p.pid));
}

/** The message a script gives, before it changes anything, when `running` processes live in `path`. */
export function refusal(what: string, path: string, running: ProcessRow[]): string {
  const sample = running
    .slice(0, 3)
    .map((p) => `  pid ${p.pid}  ${p.command.slice(0, 100)}`)
    .join("\n");
  return `refusing to ${what}: ${running.length} running process${running.length === 1 ? "" : "es"} live in ${path} (is Tomte running from there? quit it first, or choose another location)\n${sample}`;
}
