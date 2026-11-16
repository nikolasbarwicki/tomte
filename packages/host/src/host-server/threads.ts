import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Bot, MemoryScope } from "@claudebot/contract/events";

import { openThread, type HostDelegate, type Thread, type ThreadEnv } from "../bots/index.ts";

export interface ThreadHooks {
  onMemory: (scope: MemoryScope, text: string) => void;
  /** True while a routine turn runs: questions and approvals then park the run (`park`) instead of waiting for the user. */
  unattended(): boolean;
  /** Answers a question or approval during a routine turn, which parks the run. */
  park: HostDelegate;
  /** The external event a question is about: `claimed` when this bot's session was given it and it is still open, else undefined. */
  ownedEvent(claimed: string | undefined): string | undefined;
  /** Shows the user a question and resolves with their answer. `eventId` links the question to the external event its answer closes. */
  askQuestion(q: { question: string; options?: string[]; eventId?: string }): Promise<string>;
  /** Shows the user a tool call to approve; an approval allows exactly the input shown. */
  askApproval(a: {
    tool: string;
    input: Record<string, unknown>;
    reason: string;
  }): Promise<PermissionResult>;
}

/** Decisions a bot session hands the host: a question or approval becomes a card for the user, or is answered at once when no one is watching. */
export function hostDelegate(hooks: ThreadHooks): HostDelegate {
  return {
    askUser: (question, options, claimed) => {
      if (hooks.unattended()) return hooks.park.askUser(question, options);
      const eventId = hooks.ownedEvent(claimed);
      return hooks.askQuestion({
        question,
        ...(options && { options }),
        ...(eventId && { eventId }),
      });
    },
    approve: async (tool, input, reason): Promise<PermissionResult> => {
      if (hooks.unattended()) return hooks.park.approve(tool, input, reason);
      return hooks.askApproval({ tool, input, reason });
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
