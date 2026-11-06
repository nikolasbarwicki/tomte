import { getBot, type Thread } from "../../bots/index.ts";
import { withMentions, type Mention } from "../../handoffs/index.ts";
import { json } from "../http.ts";
import type { ApiContext, OpenChatRoutes } from "./context.ts";

/** Routes that act on the chat the page shows. */
export function chatRoutes({ dataRoot, chats, browser }: ApiContext): OpenChatRoutes {
  return {
    "/api/send": async ({ res, body: b, str }, chat) => {
      const ids = Array.isArray(b.mentions) ? b.mentions : [];
      const mentions: Mention[] = [];
      for (const id of ids) {
        const target = typeof id === "string" && id !== chat.bot.id ? getBot(dataRoot, id) : undefined;
        if (!target) return json(res, { error: `cannot mention ${typeof id === "string" ? id : "that"}: unknown bot or the open bot` }, 400);
        if (!mentions.some((m) => m.id === target.id)) mentions.push({ id: target.id, name: target.name });
      }
      const sent = chat.send(withMentions(str("text"), mentions), str("text"), mentions);
      if ("queued" in sent) return json(res, { ok: true, queued: sent.queued });
      json(res, { ok: true });
      sent.start();
    },
    "/api/send/cancel": async ({ res, str }) => {
      if (chats.cancelQueued(str("id"))) return json(res, { ok: true });
      return json(res, { error: "that message already reached the bot" }, 404);
    },
    "/api/answer": async ({ res, str }) => {
      if (chats.answer(str("id"), str("value"))) return json(res, { ok: true });
      return json(res, { error: "no such question" }, 404);
    },
    "/api/model": async ({ res, str }, chat) => {
      await chat.setModel(str("model"));
      return json(res, { ok: true });
    },
    "/api/effort": async ({ res, str }, chat) => {
      await chat.setEffort(str("effort") as Parameters<Thread["setEffort"]>[0]);
      return json(res, { ok: true });
    },
    "/api/session/new": async ({ res }, chat) => {
      if (!chat.newSession()) return json(res, { error: "a turn is running; wait for it to finish" }, 409);
      browser.cancelTakeover(chat.bot.id, "a new session started");
      return json(res, { ok: true });
    },
    "/api/notify": async ({ res, str }) => {
      if (!str("title")) return json(res, { error: "title required" }, 400);
      chats.notify(str("source") || "external", str("title"), str("body"));
      return json(res, { ok: true });
    },
  };
}
