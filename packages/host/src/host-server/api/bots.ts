import { BotProfileUpdate, type ToolAllowances } from "@tomte/contract/api";
import { BotAvatar } from "@tomte/contract/avatars";
import { ChatMode } from "@tomte/contract/events";
import { z } from "zod";

import {
  createBot,
  getBot,
  listAllowances,
  markSeen,
  removeAllowance,
  setBrowserEnabled,
  setBrowserHeaded,
  setChatMode,
  setChiefOfStaff,
  setProfile,
} from "../../bots/index.ts";
import { json } from "../http.ts";
import type { ApiContext, ApiRoutes } from "./context.ts";

const BotId = z.object({ botId: z.string() });
const NewBot = z.object({
  name: z.string().trim().min(1, "name required"),
  purpose: z.string().default(""),
  chiefOfStaff: z.boolean().default(false),
  ...BotAvatar.shape,
});
const BrowserEnabled = BotId.extend({ enabled: z.boolean() });
const BrowserHeaded = BotId.extend({ headed: z.boolean() });
const ChatModeChange = BotId.extend({ chatMode: ChatMode });
const AllowanceRemoval = BotId.extend({ tool: z.string().min(1) });

/** Routes that address a bot by id, or none; they work whether or not a bot is open. */
export function botRoutes({
  cwd,
  dataRoot,
  cli,
  db,
  chats,
  browser,
  routines,
  headedBrowser,
  pauseAfterAbsenceDays,
  hasActiveTasks,
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
        pauseAfterAbsenceDays,
      }),
    "/api/seen": async ({ res, parse }) => {
      const bot = getBot(dataRoot, parse(BotId).botId);
      if (!bot) return json(res, { error: "no such bot" }, 404);
      markSeen(db, bot.id, Date.now());
      chats.announceBots();
      return json(res, { ok: true });
    },
    "/api/bots/new": async ({ res, parse }) => {
      const { name, purpose, chiefOfStaff, shape, color } = parse(NewBot);
      const created = createBot(dataRoot, name, purpose, undefined, { shape, color });
      const moved = chiefOfStaff ? setChiefOfStaff(dataRoot, created.id, true) : [];
      const bot = getBot(dataRoot, created.id) ?? created;
      botsChanged();
      // The bot it was moved from is already open; the new one opens fresh with the section.
      for (const id of moved) if (id !== bot.id) chats.reconfigure(id, "chief of staff changed");
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
    "/api/bots/profile": async ({ res, parse }) => {
      const { botId, name, purpose, chiefOfStaff, shape, color } = parse(BotProfileUpdate);
      const before = getBot(dataRoot, botId);
      if (!before) return json(res, { error: "no such bot" }, 404);
      setProfile(dataRoot, botId, { name, purpose, avatar: { shape, color } });
      const moved = setChiefOfStaff(dataRoot, botId, chiefOfStaff);
      // The name, purpose and Chief of Staff section are in the system prompt; the avatar is only the page's.
      if (name !== before.name || purpose !== before.purpose)
        chats.reconfigure(botId, "profile changed");
      for (const id of moved) chats.reconfigure(id, "chief of staff changed");
      chats.announceBots();
      return json(res, getBot(dataRoot, botId));
    },
    "/api/bots/chat-mode": async ({ res, parse }) => {
      const { botId, chatMode } = parse(ChatModeChange);
      const bot = getBot(dataRoot, botId);
      if (!bot) return json(res, { error: "no such bot" }, 404);
      if (bot.chatMode === chatMode) return json(res, { ok: true });
      if (hasActiveTasks(bot.id)) return json(res, { error: "stop the running tasks first" }, 409);
      if (chats.isWorking(bot.id))
        return json(res, { error: "a turn is running; wait for it to finish" }, 409);
      setChatMode(dataRoot, bot.id, chatMode);
      // The two modes keep different sessions, so switching starts a new conversation.
      chats.newSession(bot.id);
      routines.sessionEnded(bot.id);
      browser.cancelTakeover(bot.id, "a new session started");
      chats.announceBots();
      return json(res, { ok: true });
    },
    "/api/bots/allowances": async ({ res, parse }) => {
      const { botId } = parse(BotId);
      if (!getBot(dataRoot, botId)) return json(res, { error: "no such bot" }, 404);
      return json(res, { allowances: listAllowances(db, botId) } satisfies ToolAllowances);
    },
    "/api/bots/allowances/remove": async ({ res, parse }) => {
      const { botId, tool } = parse(AllowanceRemoval);
      if (!getBot(dataRoot, botId)) return json(res, { error: "no such bot" }, 404);
      if (!removeAllowance(db, botId, tool))
        return json(res, { error: "that tool is not always allowed" }, 404);
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
