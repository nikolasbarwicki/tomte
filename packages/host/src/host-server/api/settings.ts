import {
  ClaudeGateway,
  ClaudeLoginCode,
  type ClaudeLoginStart,
  type ClaudeUsage,
  Instructions,
  MemoryUpdate,
  type ModelProvider,
  type ModelProviders,
  type ProviderStatus,
} from "@tomte/contract/api";
import { BotModel } from "@tomte/contract/events";

import {
  botMemoryPath,
  getBot,
  instructionsPath,
  readMemory,
  userMemoryPath,
  writeMemory,
} from "../../bots/index.ts";
import { remoteLoginCommand, type SignInState } from "../../harness/index.ts";
import { claudeGatewaySecretName } from "../../platform/secrets.ts";
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
  secrets,
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
      const state = await claude.checkSignIn();
      const { account, cliVersion } = claude.report();
      const gateway = claude.gateway();
      const claudeProvider: ModelProvider = {
        id: "claude",
        name: "Claude",
        vendor: "Anthropic",
        access: gateway ? "api_key" : "subscription",
        status: PROVIDER_STATUS[state],
        detail: `${cli.path} (${cli.source})`,
        connect:
          config.mode === "remote"
            ? `Sign in on this page, or run \`${remoteLoginCommand(config)}\` in a terminal on the host.`
            : "Sign in on this page, or run `claude` in a terminal and sign in with `/login`.",
        models: [...BotModel.options],
        account,
        cliVersion,
        gateway: gateway ?? null,
        login: claude.login.pending() ?? null,
      };
      return json(res, { providers: [claudeProvider] } satisfies ModelProviders);
    },
    "/api/providers/claude/usage": async ({ res }) => {
      try {
        return json(res, (await claude.usage()) satisfies ClaudeUsage);
      } catch (e) {
        return json(res, { error: `Could not read usage: ${(e as Error).message}` }, 502);
      }
    },
    "/api/providers/claude/login": async ({ res }) => {
      try {
        return json(res, (await claude.login.start()) satisfies ClaudeLoginStart);
      } catch (e) {
        return json(res, { error: (e as Error).message }, 502);
      }
    },
    "/api/providers/claude/login/code": async ({ res, parse }) => {
      const { code } = parse(ClaudeLoginCode);
      if (!claude.login.pending())
        return json(res, { error: "no Claude sign-in is in progress" }, 409);
      try {
        await claude.login.submit(code);
      } catch (e) {
        return json(res, { error: (e as Error).message }, 400);
      }
      return json(res, { ok: true, status: PROVIDER_STATUS[await claude.checkSignIn()] });
    },
    "/api/providers/claude/login/cancel": async ({ res }) => {
      claude.login.cancel();
      return json(res, { ok: true });
    },
    "/api/providers/claude/gateway": async ({ res, parse }) => {
      const gateway = parse(ClaudeGateway);
      await secrets.set(claudeGatewaySecretName, JSON.stringify(gateway));
      claude.setGateway(gateway);
      chats.reconfigure(undefined, "model provider changed");
      return json(res, { ok: true });
    },
    "/api/providers/claude/gateway/remove": async ({ res }) => {
      await secrets.delete(claudeGatewaySecretName);
      claude.setGateway(undefined);
      chats.reconfigure(undefined, "model provider changed");
      return json(res, { ok: true });
    },
  };
}
