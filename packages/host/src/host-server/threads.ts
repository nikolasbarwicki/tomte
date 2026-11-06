import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Bot, MemoryScope, ServerEvent } from "@claudebot/contract/events";

import { Thread, botContext } from "../bots/index.ts";
import type { HostServersSource, ResolvedCli } from "../harness/index.ts";
import type { IntegrationsSource } from "../integrations/index.ts";
import { headlessDelegate } from "../routines/index.ts";

export interface ThreadEnv {
  /** The workspace directory the Claude CLI runs in. */
  cwd: string;
  /** Where bots, their memory and the user memory live. */
  dataRoot: string;
  cli: ResolvedCli;
  integrations: IntegrationsSource;
  hostServers: HostServersSource;
}

export interface ThreadHooks {
  onMemory(scope: MemoryScope, text: string): void;
  /** True while a routine turn runs: questions and approvals are then answered without the user. */
  unattended(): boolean;
  /** Shows the user a question or approval card and resolves with their answer. */
  ask(event: (id: string) => ServerEvent): Promise<string>;
}

/** Opens a bot's Claude Code thread in the host. */
export function openBotThread(
  { cwd, dataRoot, cli, integrations, hostServers }: ThreadEnv,
  bot: Bot,
  resume: boolean,
  hooks: ThreadHooks,
): Thread {
  return new Thread({
    cli,
    cwd,
    ...botContext(dataRoot, bot),
    resume,
    idleMs: 10 * 60_000,
    approveAll: process.env.CLAUDEBOT_ASK_APPROVAL !== "1",
    integrations,
    hostServers: () => hostServers(bot.id),
    log: (l) => console.error(l),
    onMemory: hooks.onMemory,
    delegate: {
      askUser: (question) =>
        hooks.unattended()
          ? headlessDelegate.askUser(question)
          : hooks.ask((id) => ({ type: "ask", id, question })),
      approve: async (tool, input, reason): Promise<PermissionResult> => {
        if (hooks.unattended()) return headlessDelegate.approve(tool, input, reason);
        const v = await hooks.ask((id) => ({
          type: "approve",
          id,
          tool,
          reason,
          input: JSON.stringify(input, null, 2),
        }));
        return v === "allow"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "user declined" };
      },
    },
  });
}
