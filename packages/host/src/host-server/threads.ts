import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Bot, MemoryScope, ServerEvent } from "@claudebot/contract/events";

import {
  headlessDelegate,
  openThread,
  type HostDelegate,
  type Thread,
  type ThreadEnv,
} from "../bots/index.ts";

export interface ThreadHooks {
  onMemory: (scope: MemoryScope, text: string) => void;
  /** True while a routine turn runs: questions and approvals are then answered without the user. */
  unattended(): boolean;
  /** The external event a question is about: `claimed` when this bot's session was given it and it is still open, else undefined. */
  ownedEvent(claimed: string | undefined): string | undefined;
  /** Shows the user a question or approval card and resolves with their answer. `eventId` links the card to the external event its answer closes. */
  ask(event: (id: string) => ServerEvent, eventId?: string): Promise<string>;
}

/** Decisions a bot session hands the host: a question or approval becomes a card for the user, or is answered at once when no one is watching. */
export function hostDelegate(hooks: ThreadHooks): HostDelegate {
  return {
    askUser: (question, options, claimed) => {
      if (hooks.unattended()) return headlessDelegate.askUser(question);
      const eventId = hooks.ownedEvent(claimed);
      return hooks.ask(
        (id) => ({
          type: "ask",
          id,
          question,
          ...(options && { options }),
          ...(eventId && { eventId }),
        }),
        eventId,
      );
    },
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
  };
}

/** Opens a bot's Claude Code thread in the host. */
export function openBotThread(
  env: ThreadEnv,
  bot: Bot,
  resume: boolean,
  hooks: ThreadHooks,
): Thread {
  return openThread(env, bot, {
    resume,
    idleMs: 10 * 60_000,
    log: (l) => console.error(l),
    onMemory: hooks.onMemory,
    delegate: hostDelegate(hooks),
  });
}
