import { lstatSync, mkdirSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** An upload whose path cannot be written inside the files folder; the route answers it with 400. */
export class BadUpload extends Error {}

/** An upload that went past the per-file cap; the route answers it with 413. */
export class UploadTooLarge extends Error {
  constructor(readonly max: number) {
    super(`over the upload limit of ${max} bytes`);
  }
}

/** Where `writeUpload` saved a file: relative to the files folder, `/`-separated, and the requested path when the name was taken. */
export interface Uploaded {
  path: string;
  renamedFrom?: string;
}

/** What the filesystem says about a path that is too long or runs through a file; the caller's path is at fault, nothing else is. */
const BAD_PATH = ["ENOTDIR", "ENAMETOOLONG", "EINVAL"];

const segmentsOf = (path: string) => {
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\\") || p.includes("\0")))
    throw new BadUpload(`not a relative path: ${path}`);
  return parts;
};

const codeOf = (e: unknown) => (e as NodeJS.ErrnoException).code;

const taken = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** `name 2`, `name 3`… (before the extension of a file). */
function numbered(name: string, n: number, folder: boolean): string {
  const ext = folder ? "" : extname(name);
  return `${name.slice(0, name.length - ext.length)} ${n}${ext}`;
}

/** The folder `path`, created when missing; a symlink or a file in its place is refused, so nothing is ever written through a link a bot made. */
function enterFolder(path: string, rel: string) {
  try {
    mkdirSync(path);
  } catch (e) {
    if (codeOf(e) !== "EEXIST") throw e;
  }
  if (!lstatSync(path).isDirectory())
    throw new BadUpload(`${rel} runs through something that is not a folder`);
}

/** Passes the bytes on and fails once more than `max` have gone by. */
const capped = (max: number) => {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      done(seen > max ? new UploadTooLarge(max) : null, chunk);
    },
  });
};

/** Creates the folders of `parts` under `dir` and the new file at its end, `name 2`… when taken; the folder at depth `fresh` is a new one when taken too. */
async function place(dir: string, parts: string[], fresh: number, rel: string) {
  const last = parts[parts.length - 1]!;
  const folders = parts.slice(0, -1);
  try {
    mkdirSync(dir, { recursive: true });
    let at = dir;
    for (const [i, part] of folders.entries()) {
      let next = part;
      for (let n = 2; i === fresh - 1 && taken(join(at, next)); n++) next = numbered(part, n, true);
      folders[i] = next;
      at = join(at, next);
      enterFolder(at, rel);
    }
    for (let n = 2; ; n++) {
      const name = n === 2 && !taken(join(at, last)) ? last : numbered(last, n, false);
      try {
        return { folders, name, handle: await open(join(at, name), "wx"), at };
      } catch (e) {
        if (codeOf(e) !== "EEXIST") throw e;
      }
    }
  } catch (e) {
    if (BAD_PATH.includes(codeOf(e) ?? "")) throw new BadUpload(`cannot save ${rel}: ${codeOf(e)}`);
    throw e;
  }
}

/**
 * Streams `body` into the file `rel` under the files folder `dir`, creating the folders on the way, and returns where it
 * went. Nothing is written outside `dir`: `rel` must be relative with no `.` or `..`, and a symlink on the way is refused. A
 * file is never overwritten: a taken name becomes `name 2`, `name 3`…, and the result says what it was renamed from. With
 * `folder`, a leading folder of `rel` that is taken is renamed the same way (a new folder rather than a merge); the caller
 * writes the folder's other files under the name that comes back. More than `max` bytes throws `UploadTooLarge` and leaves no
 * file. A failure while the body is read (the client gave up) leaves none either.
 */
export async function writeUpload(
  dir: string,
  rel: string,
  body: Readable,
  max: number,
  folder?: string,
): Promise<Uploaded> {
  const parts = segmentsOf(rel);
  const fresh = folder === undefined ? 0 : segmentsOf(folder).length;
  if (
    folder !== undefined &&
    (fresh >= parts.length || segmentsOf(folder).some((p, i) => p !== parts[i]))
  )
    throw new BadUpload(`${rel} is not inside ${folder}`);

  const { folders, name, handle, at } = await place(dir, parts, fresh, rel);
  try {
    await pipeline(body, capped(max), handle.createWriteStream());
  } catch (e) {
    await rm(join(at, name), { force: true });
    throw e;
  }
  const path = [...folders, name].join("/");
  return path === rel ? { path } : { path, renamedFrom: rel };
}
