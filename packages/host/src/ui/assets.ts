import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface UiAsset {
  body: Uint8Array;
  contentType: string;
}

/** Where the built web UI comes from: a directory on disk, or (in the compiled host) files embedded in the binary. */
export interface UiAssets {
  /** The file at a URL path such as `/assets/app-1a2b.js`, or undefined when there is none, including for any path that would leave the asset root. */
  read(urlPath: string): Promise<UiAsset | undefined>;
}

/** The file a URL path names under `root`, or undefined when the path is malformed or would escape `root`. */
function insideRoot(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const segments = decoded.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return undefined;
  const file = join(root, ...segments);
  return file.startsWith(root + sep) ? file : undefined;
}

/** The assets under `dir`, read from disk on every request. */
export function directoryAssets(dir: string): UiAssets {
  const root = resolve(dir);
  return {
    async read(urlPath) {
      const path = insideRoot(root, urlPath);
      if (path === undefined) return undefined;
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) return undefined;
      const file = Bun.file(path);
      return { body: await file.bytes(), contentType: file.type };
    },
  };
}

/** The folder `bun build --compile --asset` embeds the built web UI under, next to the compiled entry; the build script and `embeddedAssets` agree on it here. */
export const EMBEDDED_UI_DIR = "web-ui";

/** The web UI embedded in the compiled host. Bun serves embedded files through the same file APIs as the disk, under the entry's `import.meta.dir`. */
export function embeddedAssets(): UiAssets {
  return directoryAssets(join(import.meta.dir, EMBEDDED_UI_DIR));
}
