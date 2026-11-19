import { UploadResponse } from "@tomte/contract/api";
import { toast } from "sonner";

import { fileSize } from "@/lib/format.ts";

import { errorOf, readJson } from "./api.ts";
import { sessionStore } from "./session.ts";
import { hostStore } from "./store.ts";

/** Why the host would refuse `file`: it is over the per-file cap. Nothing while the host has not said what its cap is. */
export function tooLargeFor(file: File, name = file.name): string | undefined {
  const cap = hostStore.get().info?.maxUploadBytes;
  return cap !== undefined && file.size > cap
    ? `${name} is ${fileSize(file.size)}; the upload limit is ${fileSize(cap)} per file`
    : undefined;
}

/**
 * Streams `file` into the open bot's files folder at `path` (relative to it, `/`-separated). `folder`, a leading part of `path`,
 * asks for a new folder when that one is taken: the answer's path then names the folder the next files of the group go into.
 * Resolves to where the host saved it (a taken name is renamed, `renamedFrom` says from what), or `undefined` when it refused
 * it or could not be reached (shown as a toast).
 */
export async function upload(
  path: string,
  file: File,
  folder?: string,
): Promise<UploadResponse | undefined> {
  const tooLarge = tooLargeFor(file, path);
  if (tooLarge) {
    toast.error(tooLarge);
    return undefined;
  }
  const query = new URLSearchParams({ path, ...(folder !== undefined && { folder }) });
  let res: Response;
  try {
    res = await fetch(`/api/files/upload?${query}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
  } catch {
    toast.error(`Could not upload ${path}: the host did not answer`);
    return undefined;
  }
  if (res.status === 401) sessionStore.set("unpaired");
  if (!res.ok) {
    toast.error(await errorOf(res));
    return undefined;
  }
  return readJson(res, UploadResponse);
}

/** How many files go up at once; a folder of many small files would otherwise wait on each round trip. */
const PARALLEL = 4;

/**
 * Uploads each of `items` to its own `path` (see `upload`), four at a time, and resolves to the results in order: `undefined`
 * for a refused file and, with `stopOnFailure`, for the ones never started after it.
 */
export async function uploadAll(
  items: { path: string; file: File }[],
  { stopOnFailure = false } = {},
): Promise<(UploadResponse | undefined)[]> {
  const results: (UploadResponse | undefined)[] = items.map(() => undefined);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const i = next++;
      const { path, file } = items[i]!;
      results[i] = await upload(path, file);
      if (results[i] === undefined && stopOnFailure) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return results;
}
