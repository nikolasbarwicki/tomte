import { basename, extname, join } from "node:path";

import type { Note } from "./needs-you-banner.ts";

/** The part of Electron's `DownloadItem` the handler uses. */
export interface DownloadItem {
  getFilename(): string;
  setSavePath(path: string): void;
  once(event: "done", listener: (event: unknown, state: string) => void): unknown;
}

export interface DownloadsDeps {
  /** The user's downloads folder, asked at each download. */
  folder: () => string;
  exists: (path: string) => boolean;
  notify: (note: Note) => void;
  /** Selects `path` in the system file manager. */
  reveal: (path: string) => void;
  /** What the file manager is called here: Finder, Explorer or the file manager. */
  fileManager: string;
  log: (message: string) => void;
}

/** `name` in `folder`, or `name (1)`, `name (2)` and so on before its extension when that is taken: a download never replaces a file. */
export function freePath(folder: string, name: string, exists: (path: string) => boolean): string {
  const safe = basename(name) || "download";
  const first = join(folder, safe);
  if (!exists(first)) return first;
  const extension = extname(safe);
  const stem = safe.slice(0, safe.length - extension.length);
  for (let n = 1; ; n++) {
    const candidate = join(folder, `${stem} (${n})${extension}`);
    if (!exists(candidate)) return candidate;
  }
}

export const fileManagerName = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? "Finder" : platform === "win32" ? "File Explorer" : "the file manager";

/**
 * Saves a download the window's page started into the downloads folder without asking, then announces it. Clicking the
 * announcement selects the file in the system file manager. A download is a copy: nothing here syncs or watches it.
 */
export function handleDownload(item: DownloadItem, deps: DownloadsDeps): void {
  const path = freePath(deps.folder(), item.getFilename(), deps.exists);
  const name = basename(path);
  item.setSavePath(path);
  item.once("done", (_event, state) => {
    if (state === "completed")
      deps.notify({
        title: `Downloaded ${name}`,
        body: `Click to show it in ${deps.fileManager}.`,
        onClick: () => deps.reveal(path),
      });
    else if (state === "interrupted") {
      deps.log(`download of ${name} was interrupted`);
      deps.notify({
        title: `Download of ${name} failed`,
        body: "Nothing was saved.",
        onClick() {},
      });
    }
  });
}
