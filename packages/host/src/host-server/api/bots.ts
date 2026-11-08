import { BotAvatar } from "@claudebot/contract/avatars";
import { z } from "zod";

import {
  createBot,
  getBot,
  markSeen,
  setBrowserEnabled,
  setBrowserHeaded,
} from "../../bots/index.ts";
import { json } from "../http.ts";
import type { ApiContext, ApiRoutes } from "./context.ts";

const BotId = z.object({ botId: z.string() });
const NewBot = z.object({
  name: z.string().trim().min(1, "name required"),
  purpose: z.string().default(""),
  ...BotAvatar.shape,
});
const BrowserEnabled = BotId.extend({ enabled: z.boolean() });
const BrowserHeaded = BotId.extend({ headed: z.boolean() });

/** Routes that address a bot by id, or none; they work whether or not a bot is open. */
export function botRoutes({
  cwd,
  dataRoot,
  cli,
  db,
  chats,
  browser,
  headedBrowser,
  botsChanged,
  removeBot,
}: ApiContext): ApiRoutes {
  const browserLifecycle: ApiRoutes[string] = async ({ res, path, parse }) => {
    const bot = getBot(dataRoot, parse(BotId).botId);
    if (!bot) return json(res, { error: "no such bot" }, 404);
    if (path.endsWith("/sign-out")) await browser.signOut(bot.id);
    else await browser.restart(bot.id);
    return json(res, { ok: true });
  };
  return {
    "/api/info": async ({ res }) =>
      json(res, {
        cwd,
        cli: `${cli.path} (${cli.source})`,
        browser: browser.status(),
      }),
    "/api/seen": async ({ res, parse }) => {
      const bot = getBot(dataRoot, parse(BotId).botId);
      if (!bot) return json(res, { error: "no such bot" }, 404);
      markSeen(db, bot.id, Date.now());
      chats.announceBots();
      return json(res, { ok: true });
    },
    "/api/bots/new": async ({ res, parse }) => {
      const { name, purpose, face, stroke } = parse(NewBot);
      const bot = createBot(dataRoot, name, purpose, undefined, { face, stroke });
      botsChanged();
      await chats.switchTo(bot);
      return json(res, bot);
    },
    "/api/bots/delete": async ({ res, parse }) => {
      const bot = getBot(dataRoot, parse(BotId).botId);
      if (!bot) return json(res, { error: "no such bot" }, 404);
      if (chats.isWorking(bot.id))
        return json(res, { error: `${bot.name} is working; wait for it to finish` }, 409);
      await removeBot(bot.id);
      return json(res, { ok: true });
    },
    "/api/bots/browser": async ({ res, parse }) => {
      const { botId, enabled } = parse(BrowserEnabled);
      const bot = getBot(dataRoot, botId);
      if (!bot) return json(res, { error: "no such bot" }, 404);
      const engine = browser.status();
      if (enabled && engine.status === "unavailable")
        return json(res, { error: engine.reason }, 409);
      setBrowserEnabled(dataRoot, bot.id, enabled);
      chats.reconfigure(bot.id, "browser setting changed");
      chats.announceBots();
      return json(res, { ok: true });
    },
    "/api/bots/browser/headed": async ({ res, parse }) => {
      const { botId, headed } = parse(BrowserHeaded);
      const bot = getBot(dataRoot, botId);
      if (!bot) return json(res, { error: "no such bot" }, 404);
      if (headed && !headedBrowser)
        return json(res, { error: "headed Chrome is not available on this host" }, 409);
      setBrowserHeaded(dataRoot, bot.id, headed);
      // The window is chosen when the engine launches Chrome, so a running browser must restart to pick it up.
      await browser.restart(bot.id);
      chats.announceBots();
      return json(res, { ok: true });
    },
    "/api/bots/browser/restart": browserLifecycle,
    "/api/bots/browser/sign-out": browserLifecycle,
    "/api/open": async ({ res, parse }) => {
      const bot = getBot(dataRoot, parse(BotId).botId);
      if (!bot) return json(res, { error: "no such bot" }, 404);
      if (bot.id !== chats.currentBotId()) await chats.switchTo(bot);
      return json(res, bot);
    },
  };
}
