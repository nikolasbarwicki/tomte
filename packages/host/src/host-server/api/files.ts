import { closeSync, createReadStream, existsSync } from "node:fs";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

import { botFilesPath, deleteFile, openFileInside, resolveInside } from "../../bots/index.ts";
import { json } from "../http.ts";
import type { ApiContext, OpenChatRoutes } from "./context.ts";

const FilePath = z.object({ path: z.string() });
/** No `path` reveals the folder itself. */
const RevealPath = z.object({ path: z.string().default("") });

/** RFC 6266 `Content-Disposition` for a download: an ASCII fallback plus the exact name as an RFC 5987 `filename*`. */
function attachment(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  const exact = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`;
}

/** The open bot's Files panel. */
export function fileRoutes({ dataRoot, reveal }: ApiContext): OpenChatRoutes {
  return {
    "/api/files/delete": async ({ res, parse }, chat) => {
      if (!deleteFile(botFilesPath(dataRoot, chat.bot.id), parse(FilePath).path))
        return json(res, { error: "no such file" }, 404);
      return json(res, { ok: true });
    },
    "/api/files/reveal": async ({ res, parse }, chat) => {
      if (!reveal) return json(res, { error: "not found" }, 404);
      const dir = botFilesPath(dataRoot, chat.bot.id);
      const { path } = parse(RevealPath);
      const target = path ? resolveInside(dir, path) : dir;
      if (!target || !existsSync(target)) return json(res, { error: "no such file" }, 404);
      reveal(target, (l) => console.error(l));
      return json(res, { ok: true });
    },
    // A GET with the path in the query, so the web page can use a plain link with its session cookie.
    "/api/files/download": async ({ res, query }, chat) => {
      const rel = query.get("path") ?? "";
      const file = openFileInside(botFilesPath(dataRoot, chat.bot.id), rel);
      if (!file) return json(res, { error: "no such file" }, 404);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": attachment(basename(rel)),
        "content-length": file.size,
        "x-content-type-options": "nosniff",
      });
      if (file.size === 0) {
        closeSync(file.fd);
        res.end();
        return;
      }
      await pipeline(createReadStream("", { fd: file.fd, start: 0, end: file.size - 1 }), res);
    },
  };
}
