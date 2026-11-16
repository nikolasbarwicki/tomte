import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** The input keys through which each file tool names a path it reads or writes. */
const PATH_KEYS: Record<string, string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["path"],
  Grep: ["path"],
  LS: ["path"],
};

/** The directory part of a glob pattern that holds no wildcard, which is where the pattern starts looking. */
function globBase(pattern: string): string {
  const parts = pattern.split(/[\\/]/);
  const end = parts.findIndex((p) => /[*?[\]{}]/.test(p));
  return (
    parts.slice(0, end === -1 ? parts.length : end).join("/") ||
    (pattern.startsWith("/") ? "/" : "")
  );
}

/** Follows symlinks in the part of the path that exists, so a link inside a root that points out of it is seen for what it is. */
function realTarget(path: string): string {
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  return resolve(realpathSync(existing), path.slice(existing.length).replace(/^[/\\]+/, ""));
}

/** `~` and `~/…` are the home directory, as the CLI's file tools read them; `~name` is somebody else's, which nothing allows. */
function expandHome(path: string): string | undefined {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path.startsWith("~") ? undefined : path;
}

/** Says why a tool call must be refused, or undefined when it may run. */
export type PathGuard = (toolName: string, input: unknown) => string | undefined;

/**
 * v3's PreToolUse path guard, as defence in depth for a background agent's file tools. The CLI and `canUseTool` would ask the
 * user about a path outside the workspace, but an agent's file tools have no business there, so the guard refuses outright
 * whatever reaches outside `roots`: `..`, absolute paths, `~` and symlinks that leave a root. It returns why a call must be
 * refused, or undefined when the tool is not a file tool or every path it names is inside a root. Relative paths start at `cwd`.
 * Bash is not covered: the sandbox confines it.
 */
export function createPathGuard(o: { cwd: string; roots: string[] }): PathGuard {
  return (toolName, input) => {
    const keys = PATH_KEYS[toolName];
    if (!keys) return undefined;
    const roots = o.roots.flatMap((r) => (existsSync(r) ? [realpathSync(r)] : []));
    const cwd = existsSync(o.cwd) ? realpathSync(o.cwd) : resolve(o.cwd);
    const args = (input ?? {}) as Record<string, unknown>;
    const named: { key: string; value: unknown; glob: boolean }[] = keys.flatMap((k) =>
      args[k] === undefined || args[k] === null ? [] : [{ key: k, value: args[k], glob: false }],
    );
    // A glob pattern names a place too: its fixed prefix, below `path` when the tool has one.
    if (toolName === "Glob" && args.pattern !== undefined)
      named.push({ key: "pattern", value: args.pattern, glob: true });
    for (const { key, value, glob } of named) {
      if (typeof value !== "string") return `${toolName}.${key} must be a path string`;
      const expanded = expandHome(glob ? globBase(value) : value);
      const start = glob && typeof args.path === "string" ? resolve(cwd, args.path) : cwd;
      const target =
        expanded === undefined
          ? undefined
          : realTarget(isAbsolute(expanded) ? resolve(expanded) : resolve(start, expanded));
      if (target === undefined || !roots.some((r) => target === r || target.startsWith(r + sep)))
        return `${value} is outside the places you may work in. Use paths inside your working directory or your files folder.`;
    }
    return undefined;
  };
}
