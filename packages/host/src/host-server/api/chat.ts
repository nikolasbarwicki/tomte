import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { getBot } from "../../bots/index.ts";
import { withMentions, type Mention } from "../../handoffs/index.ts";
import { json } from "../http.ts";
import type { ApiContext, OpenChatRoutes } from "./context.ts";

const Send = z.object({ text: z.string(), mentions: z.array(z.string()).default([]) });
const Id = z.object({ id: z.string() });
const Answer = Id.extend({ value: z.string() });
const Model = z.object({ model: z.string() });
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];
const Effort = z.object({ effort: z.enum(EFFORTS) });
const Notify = z.object({
  source: z.string().default("external"),
  title: z.string().min(1, "title required"),
  body: z.string().default(""),
});

/** Routes that act on the chat the page shows. */
export function chatRoutes({ dataRoot, chats, browser }: ApiContext): OpenChatRoutes {
  return {
    "/api/send": async ({ res, parse }, chat) => {
      const { text, mentions: ids } = parse(Send);
      const mentions: Mention[] = [];
      for (const id of ids) {
        const target = id !== chat.bot.id ? getBot(dataRoot, id) : undefined;
        if (!target)
          return json(res, { error: `cannot mention ${id}: unknown bot or the open bot` }, 400);
        if (!mentions.some((m) => m.id === target.id))
          mentions.push({ id: target.id, name: target.name });
      }
      const sent = chat.send(withMentions(text, mentions), text, mentions);
      if ("queued" in sent) return json(res, { ok: true, queued: sent.queued });
      json(res, { ok: true });
      sent.start();
    },
    "/api/send/cancel": async ({ res, parse }) => {
      if (chats.cancelQueued(parse(Id).id)) return json(res, { ok: true });
      return json(res, { error: "that message already reached the bot" }, 404);
    },
    "/api/answer": async ({ res, parse }) => {
      const { id, value } = parse(Answer);
      if (chats.answer(id, value)) return json(res, { ok: true });
      return json(res, { error: "no such question" }, 404);
    },
    "/api/model": async ({ res, parse }, chat) => {
      await chat.setModel(parse(Model).model);
      return json(res, { ok: true });
    },
    "/api/effort": async ({ res, parse }, chat) => {
      await chat.setEffort(parse(Effort).effort);
      return json(res, { ok: true });
    },
    "/api/session/new": async ({ res }, chat) => {
      if (!chat.newSession())
        return json(res, { error: "a turn is running; wait for it to finish" }, 409);
      browser.cancelTakeover(chat.bot.id, "a new session started");
      return json(res, { ok: true });
    },
    "/api/notify": async ({ res, parse }) => {
      const { source, title, body } = parse(Notify);
      chats.notify(source || "external", title, body);
      return json(res, { ok: true });
    },
  };
}
