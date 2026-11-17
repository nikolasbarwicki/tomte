import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BotsToolContext } from "./context.ts";
import { errorResult, jsonResult } from "./result.ts";

/** The most bots the host holds before `create_bot` refuses; the owner can still add more in the app. */
const MAX_BOTS = 20;

/**
 * Sized so the approval card, which shows exactly these arguments, stays under the cap beyond which a card on a channel offers
 * Deny only (`wait-cards.ts`).
 */
const MAX_NAME_LENGTH = 80;
const MAX_PURPOSE_LENGTH = 400;
const MAX_MEMORY_LENGTH = 1200;

const UNATTENDED_CREATE_REFUSAL = "scheduled runs cannot create bots; ask the user in chat";

export function registerCreateBot(mcp: McpServer, ctx: BotsToolContext) {
  mcp.registerTool(
    "create_bot",
    {
      description: `Propose a new bot when no existing bot fits the work. Every call shows the owner an approval card with the name, purpose and memory seed, and nothing is created unless they approve; there is no "always allow". The bot starts with its browser off, and you cannot change it afterwards: to give it work, hand off to it. Not available in scheduled runs, and refused when the host already has ${MAX_BOTS} bots.`,
      inputSchema: {
        name: z.string().describe(`Short name, at most ${MAX_NAME_LENGTH} characters`),
        purpose: z
          .string()
          .describe(
            `What the bot is for, at most ${MAX_PURPOSE_LENGTH} characters; other bots read it to decide what to hand it`,
          ),
        memory: z
          .string()
          .optional()
          .describe(
            `A seed for the new bot's own memory, at most ${MAX_MEMORY_LENGTH} characters: what it needs to know to start`,
          ),
        chat_mode: z
          .enum(["standard", "double_loop"])
          .optional()
          .describe(
            "standard (the default) answers with the bot's own model; double_loop answers at once and runs heavy work in background agents",
          ),
      },
    },
    ({ name, purpose, memory, chat_mode }) => {
      if (ctx.unattended()) return errorResult(UNATTENDED_CREATE_REFUSAL);
      const spec = {
        name: name.trim(),
        purpose: purpose.trim(),
        memory: memory?.trim() ?? "",
        chatMode: chat_mode ?? ("standard" as const),
      };
      if (spec.name === "") return errorResult("the name is empty");
      if (spec.name.length > MAX_NAME_LENGTH)
        return errorResult(
          `the name is ${spec.name.length} characters; keep it to ${MAX_NAME_LENGTH} or fewer`,
        );
      if (spec.purpose === "") return errorResult("the purpose is empty; say what the bot is for");
      if (spec.purpose.length > MAX_PURPOSE_LENGTH)
        return errorResult(
          `the purpose is ${spec.purpose.length} characters; keep it to ${MAX_PURPOSE_LENGTH} or fewer`,
        );
      if (spec.memory.length > MAX_MEMORY_LENGTH)
        return errorResult(
          `the memory seed is ${spec.memory.length} characters; keep it to ${MAX_MEMORY_LENGTH} or fewer`,
        );
      if (ctx.cards().length >= MAX_BOTS)
        return errorResult(
          `the host already has ${MAX_BOTS} bots, the most create_bot allows; ask the owner to delete one`,
        );
      const bot = ctx.createBot(spec);
      return jsonResult({
        bot_id: bot.id,
        name: bot.name,
        chat_mode: bot.chatMode,
        note: "The bot exists now, with its browser off. Tell the owner, and hand work to it with hand_off.",
      });
    },
  );
}
