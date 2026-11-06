import { existsSync } from "node:fs";
import { botFilesPath, deleteFile, resolveInside, reveal } from "../../bots/index.ts";
import { json } from "../http.ts";
import type { ApiContext, OpenChatRoutes } from "./context.ts";

/** The open bot's Files panel. */
export function fileRoutes({ dataRoot }: ApiContext): OpenChatRoutes {
  return {
    "/api/files/delete": async ({ res, str }, chat) => {
      if (!deleteFile(botFilesPath(dataRoot, chat.bot.id), str("path"))) return json(res, { error: "no such file" }, 404);
      return json(res, { ok: true });
    },
    "/api/files/reveal": async ({ res, str }, chat) => {
      const dir = botFilesPath(dataRoot, chat.bot.id);
      const target = str("path") ? resolveInside(dir, str("path")) : dir;
      if (!target || !existsSync(target)) return json(res, { error: "no such file" }, 404);
      reveal(target, (l) => console.error(l));
      return json(res, { ok: true });
    },
  };
}
