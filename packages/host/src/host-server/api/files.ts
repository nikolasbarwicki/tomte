import { existsSync } from "node:fs";

import { z } from "zod";

import { botFilesPath, deleteFile, resolveInside, reveal } from "../../bots/index.ts";
import { json } from "../http.ts";
import type { ApiContext, OpenChatRoutes } from "./context.ts";

const FilePath = z.object({ path: z.string() });
/** No `path` reveals the folder itself. */
const RevealPath = z.object({ path: z.string().default("") });

/** The open bot's Files panel. */
export function fileRoutes({ dataRoot }: ApiContext): OpenChatRoutes {
  return {
    "/api/files/delete": async ({ res, parse }, chat) => {
      if (!deleteFile(botFilesPath(dataRoot, chat.bot.id), parse(FilePath).path))
        return json(res, { error: "no such file" }, 404);
      return json(res, { ok: true });
    },
    "/api/files/reveal": async ({ res, parse }, chat) => {
      const dir = botFilesPath(dataRoot, chat.bot.id);
      const { path } = parse(RevealPath);
      const target = path ? resolveInside(dir, path) : dir;
      if (!target || !existsSync(target)) return json(res, { error: "no such file" }, 404);
      reveal(target, (l) => console.error(l));
      return json(res, { ok: true });
    },
  };
}
