import { createBot, getBot, markSeen, setBrowserEnabled, setBrowserHeaded } from "../../bots/index.ts";
import { isFace, isStroke } from "@claudebot/contract/avatars";
import { json } from "../http.ts";
import type { ApiContext, ApiRoutes } from "./context.ts";

/** Routes that address a bot by id, or none; they work whether or not a bot is open. */
export function botRoutes({ cwd, dataRoot, cli, db, chats, browser }: ApiContext): ApiRoutes {
  const browserLifecycle: ApiRoutes[string] = async ({ res, path, str }) => {
    const bot = getBot(dataRoot, str("botId"));
    if (!bot) return json(res, { error: "no such bot" }, 404);
    if (path.endsWith("/sign-out")) await browser.signOut(bot.id);
    else await browser.restart(bot.id);
    return json(res, { ok: true });
  };
  return {
    "/api/info": async ({ res }) =>
      json(res, { cwd, cli: `${cli.path} (${cli.source})`, auth: process.env.ANTHROPIC_API_KEY ? "api key" : "CLI stored login", browser: browser.status() }),
    "/api/seen": async ({ res, str }) => {
      const bot = getBot(dataRoot, str("botId"));
      if (!bot) return json(res, { error: "no such bot" }, 404);
      markSeen(db, bot.id, Date.now());
      chats.announceBots();
      return json(res, { ok: true });
    },
    "/api/bots/new": async ({ res, str }) => {
      if (!str("name").trim()) return json(res, { error: "name required" }, 400);
      const face = str("face");
      const stroke = str("stroke");
      if (!isFace(face) || !isStroke(stroke)) return json(res, { error: "unknown avatar face or stroke color" }, 400);
      const bot = createBot(dataRoot, str("name"), str("purpose"), undefined, { face, stroke });
      await chats.switchTo(bot);
      return json(res, bot);
    },
    "/api/bots/browser": async ({ res, body: b, str }) => {
      const bot = getBot(dataRoot, str("botId"));
      if (!bot) return json(res, { error: "no such bot" }, 404);
      if (typeof b.enabled !== "boolean") return json(res, { error: "enabled must be true or false" }, 400);
      const engine = browser.status();
      if (b.enabled && engine.status === "unavailable") return json(res, { error: engine.reason }, 409);
      setBrowserEnabled(dataRoot, bot.id, b.enabled);
      chats.reconfigure(bot.id, "browser setting changed");
      chats.announceBots();
      return json(res, { ok: true });
    },
    "/api/bots/browser/headed": async ({ res, body: b, str }) => {
      const bot = getBot(dataRoot, str("botId"));
      if (!bot) return json(res, { error: "no such bot" }, 404);
      if (typeof b.headed !== "boolean") return json(res, { error: "headed must be true or false" }, 400);
      setBrowserHeaded(dataRoot, bot.id, b.headed);
      // The window is chosen when the engine launches Chrome, so a running browser must restart to pick it up.
      await browser.restart(bot.id);
      chats.announceBots();
      return json(res, { ok: true });
    },
    "/api/bots/browser/restart": browserLifecycle,
    "/api/bots/browser/sign-out": browserLifecycle,
    "/api/open": async ({ res, str }) => {
      const bot = getBot(dataRoot, str("botId"));
      if (!bot) return json(res, { error: "no such bot" }, 404);
      if (bot.id !== chats.currentBotId()) await chats.switchTo(bot);
      return json(res, bot);
    },
  };
}
