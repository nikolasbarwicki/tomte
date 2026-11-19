import type { IncomingMessage, ServerResponse } from "node:http";

import { BadUpload, botFilesPath, UploadTooLarge, writeUpload } from "../../bots/index.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";

const mib = (bytes: number) => `${bytes / 2 ** 20} MiB`;

/** Answers before the body is read, then closes: the unread bytes would otherwise be taken for the next request. */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string) {
  res
    .writeHead(status, { "content-type": "application/json", connection: "close" })
    .end(JSON.stringify({ error }), () => req.destroy());
}

/**
 * `POST /api/files/upload?path=<relative path>[&folder=<leading folders of path>]`: streams the request body into the open
 * bot's files folder, at most the host's per-file cap, and answers an `UploadResponse`. `path` is relative to the files
 * folder; one that escapes it answers 400, a file over the cap 413 naming the cap. A name that is taken is renamed, and with
 * `folder` so is a taken folder (see `writeUpload`).
 */
export async function uploadFile(
  { dataRoot, chats, config }: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
) {
  const chat = chats.open();
  if (!chat) return refuse(req, res, 409, "no bot open; create one first");
  const rel = query.get("path");
  if (!rel) return refuse(req, res, 400, "path is required");
  const cap = config.maxUploadBytes;
  const tooLarge = `${rel} is over the upload limit of ${mib(cap)} per file`;
  if (Number(req.headers["content-length"]) > cap) return refuse(req, res, 413, tooLarge);
  try {
    json(
      res,
      await writeUpload(
        botFilesPath(dataRoot, chat.bot.id),
        rel,
        req,
        cap,
        query.get("folder") ?? undefined,
      ),
    );
  } catch (e) {
    if (res.headersSent || res.destroyed) return;
    if (e instanceof UploadTooLarge) return refuse(req, res, 413, tooLarge);
    if (e instanceof BadUpload) return refuse(req, res, 400, e.message);
    throw e;
  }
}
