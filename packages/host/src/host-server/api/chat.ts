import { EffortLevel } from "@claudebot/contract/api";
import { z } from "zod";

import { getBot } from "../../bots/index.ts";
import { withMentions, type Mention } from "../../handoffs/index.ts";
import { json } from "../http.ts";
import type { ApiContext, OpenChatRoutes } from "./context.ts";

const Send = z.object({
  text: z.string(),
  mentions: z.array(z.string()).default([]),
  /** The needs-you item this message answers. The host resolves the bot's pending question about it, or else sends the message and closes the item once it reaches the bot. */
  eventId: z.string().min(1).optional(),
  /** With `eventId`: what a pending question about the item receives, when it is not the message itself (a chip's option). */
  answer: z.string().optional(),
});
const Id = z.object({ id: z.string() });
const Answer = Id.extend({ value: z.string() });
const Model = z.object({ model: z.string() });
const Effort = z.object({ effort: EffortLevel });

/** Routes that act on the chat the page shows. */
export function chatRoutes({ dataRoot, chats, browser }: ApiContext): OpenChatRoutes {
  return {
    "/api/send": async ({ res, parse }, chat) => {
      const { text, mentions: ids, eventId, answer } = parse(Send);
      const mentions: Mention[] = [];
      for (const id of ids) {
        const target = id !== chat.bot.id ? getBot(dataRoot, id) : undefined;
        if (!target)
          return json(res, { error: `cannot mention ${id}: unknown bot or the open bot` }, 400);
        if (!mentions.some((m) => m.id === target.id))
          mentions.push({ id: target.id, name: target.name });
      }
      const sent = chat.send(withMentions(text, mentions), text, mentions, eventId, answer);
      if ("refused" in sent) return json(res, { error: sent.refused }, 409);
      if ("answered" in sent) return json(res, { ok: true, outcome: "answered" });
      if ("queued" in sent) return json(res, { ok: true, outcome: "queued", queued: sent.queued });
      json(res, { ok: true, outcome: "sent" });
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
  };
}
