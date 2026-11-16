import {
  Instructions,
  MemoryUpdate,
  type ModelProvider,
  type ModelProviders,
  type ProviderStatus,
} from "@claudebot/contract/api";
import { BotModel } from "@claudebot/contract/events";

import {
  botMemoryPath,
  getBot,
  instructionsPath,
  readMemory,
  userMemoryPath,
  writeMemory,
} from "../../bots/index.ts";
import { remoteLoginCommand, type SignInState } from "../../harness/index.ts";
import { json } from "../http.ts";
import type { ApiContext, ApiRoutes } from "./context.ts";

const PROVIDER_STATUS: Record<SignInState, ProviderStatus> = {
  "signed-in": "connected",
  "signed-out": "disconnected",
  unknown: "unknown",
};

/** Routes behind the Settings screen and the bot's memory page: the user's instructions, memory files and model providers. Each addresses no open bot. */
export function settingsRoutes({
  dataRoot,
  cli,
  claude,
  config,
  chats,
  events,
}: ApiContext): ApiRoutes {
  return {
    "/api/memory/update": async ({ res, parse }) => {
      const update = parse(MemoryUpdate);
      if (update.scope === "user") writeMemory(userMemoryPath(dataRoot), update.text);
      else {
        if (!getBot(dataRoot, update.botId)) return json(res, { error: "no such bot" }, 404);
        writeMemory(botMemoryPath(dataRoot, update.botId), update.text);
      }
      // What the page shows is the file as saved (trimmed), and only the open bot's memory is on the page.
      if (update.scope === "user" || update.botId === chats.currentBotId())
        events.broadcast({
          type: "memory",
          scope: update.scope,
          text: readMemory(
            update.scope === "user"
              ? userMemoryPath(dataRoot)
              : botMemoryPath(dataRoot, update.botId),
          ),
        });
      chats.reconfigure(update.scope === "user" ? undefined : update.botId, "memory changed");
      return json(res, { ok: true });
    },
    "/api/instructions": async ({ res }) =>
      json(res, { text: readMemory(instructionsPath(dataRoot)) } satisfies Instructions),
    "/api/instructions/update": async ({ res, parse }) => {
      writeMemory(instructionsPath(dataRoot), parse(Instructions).text);
      chats.reconfigure(undefined, "instructions changed");
      return json(res, { ok: true });
    },
    "/api/providers": async ({ res }) => {
      const claudeProvider: ModelProvider = {
        id: "claude",
        name: "Claude",
        vendor: "Anthropic",
        access: "subscription",
        status: PROVIDER_STATUS[await claude.checkSignIn()],
        detail: `${cli.path} (${cli.source})`,
        connect:
          config.mode === "remote"
            ? `Run \`${remoteLoginCommand(config)}\` in a terminal on the host.`
            : "Run `claude` in a terminal and sign in with `/login`.",
        models: [...BotModel.options],
      };
      return json(res, { providers: [claudeProvider] } satisfies ModelProviders);
    },
  };
}
