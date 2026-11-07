import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
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

/** A regular file opened for reading; the caller closes `fd` (handing it to a stream does). */
interface OpenedFile {
  fd: number;
  size: number;
}

/** What a missing path, a non-directory path component, a symlink loop or an unreadable file looks like; every other failure is a bug and propagates. */
const NOT_READABLE = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EISDIR", "ENAMETOOLONG"]);

/**
 * Opens the regular file `rel` under `dir` for reading, or returns undefined when `rel` escapes `dir`, names a missing
 * file, a directory or anything but a regular file, or a symlink resolves outside `dir`. The caller reads from the
 * returned descriptor, so what it reads is what was checked: after the open, the path is resolved again and must
 * still lead inside `dir` to the very file the descriptor holds.
 */
export function openFileInside(dir: string, rel: string): OpenedFile | undefined {
  const abs = resolveInside(dir, rel);
  if (!abs) return undefined;
  let fd: number | undefined;
  try {
    const root = realpathSync(dir);
    const target = resolveInside(root, realpathSync(abs));
    if (!target) return undefined;
    // O_NONBLOCK keeps a FIFO swapped in after the check from hanging the open; it has no effect on regular files.
    fd = openSync(target, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    const again = resolveInside(root, realpathSync(abs));
    if (opened.isFile() && again) {
      const found = statSync(again);
      if (found.dev === opened.dev && found.ino === opened.ino) return { fd, size: opened.size };
    }
  } catch (e) {
    if (!NOT_READABLE.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
  }
  if (fd !== undefined) closeSync(fd);
  return undefined;
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
