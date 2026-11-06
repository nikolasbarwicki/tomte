import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { BotFile } from "@claudebot/contract/events";

const IGNORED = new Set([".DS_Store"]);

/** Regular files under `dir`, newest first; paths are relative and `/`-separated. Symlinks are skipped. */
export function listFiles(dir: string): BotFile[] {
  const out: BotFile[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (IGNORED.has(e.name)) continue;
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        const s = lstatSync(abs);
        out.push({ path: relative(dir, abs).split(sep).join("/"), size: s.size, mtime: s.mtimeMs });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Absolute path of `rel` inside `dir`, or undefined when it escapes `dir`. */
export function resolveInside(dir: string, rel: string): string | undefined {
  const abs = resolve(dir, rel);
  const r = relative(dir, abs);
  return r && !r.startsWith("..") && !isAbsolute(r) ? abs : undefined;
}

/** Delete one file, then prune subfolders it leaves empty (never `dir` itself). */
export function deleteFile(dir: string, rel: string): boolean {
  const abs = resolveInside(dir, rel);
  if (!abs || !existsSync(abs) || !lstatSync(abs).isFile()) return false;
  rmSync(abs);
  for (
    let d = dirname(abs);
    d !== dir && readdirSync(d).every((n) => IGNORED.has(n));
    d = dirname(d)
  )
    rmSync(d, { recursive: true });
  return true;
}

/** Show `path` in the OS file manager: selected in its folder for files, opened for folders. */
export function reveal(path: string, log: (l: string) => void) {
  const folder = lstatSync(path).isDirectory();
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", folder ? [path] : ["-R", path]]
      : process.platform === "win32"
        ? ["explorer", folder ? [path] : [`/select,${path}`]]
        : ["xdg-open", [folder ? path : dirname(path)]];
  execFile(cmd, args, (e) => e && log(`[host] ${cmd} failed: ${e.message}`));
}

/** Call `onChange` (debounced) whenever anything under `dir` changes. */
export function watchFiles(dir: string, onChange: () => void): FSWatcher {
  let t: NodeJS.Timeout | undefined;
  return watch(dir, { recursive: true }, () => {
    clearTimeout(t);
    t = setTimeout(onChange, 150);
  });
}
