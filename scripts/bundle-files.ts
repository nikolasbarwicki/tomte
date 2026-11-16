// What the signing checks need from the file system to find what a packaged app bundles (the browser's parts): a seam,
// so the checks run on a listed tree in tests and on the real one in `signing.ts verify` and `sign-local.ts`.
import { readdir, stat } from "node:fs/promises";

export interface BundleFiles {
  exists(path: string): Promise<boolean>;
  /** The entries directly inside `dir`; throws when it is missing. A symlink is listed as a `file` and never followed. */
  list(dir: string): Promise<{ name: string; kind: "dir" | "file" }[]>;
}

export const diskFiles: BundleFiles = {
  exists: (path) =>
    stat(path).then(
      () => true,
      () => false,
    ),
  list: async (dir) =>
    (await readdir(dir, { withFileTypes: true })).map((e) => ({
      name: e.name,
      kind: e.isDirectory() ? "dir" : "file",
    })),
};
