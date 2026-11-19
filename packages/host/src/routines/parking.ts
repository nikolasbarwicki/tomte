import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import type { HostDelegate } from "../bots/index.ts";
import { approvalActions, canonicalInput, type Waits } from "../waits/index.ts";

/**
 * Answers a bot's question or tool approval during a routine run, when nobody is watching: it stores the request as a human wait and
 * returns at once. The run's turn then ends on its own (`createRoutines`), the run parks, and the owner's answer reaches the session
 * as a message. A tool the owner already allowed for exactly this input is allowed once, which is how a resumed run gets past the
 * approval it parked on.
 */
export function parkingDelegate(
  waits: Pick<Waits, "open" | "consumeApproval">,
  botId: string,
  locked: (tool: string) => boolean,
): HostDelegate {
  return {
    askUser: async (question, options) => {
      waits.open(botId, {
        kind: "question",
        payload: { question, ...(options && { options }) },
        actions: [],
      });
      return "Your question was sent to the owner, who is not watching this run. The answer will arrive later as a message in this conversation. End your turn now: do not guess, do not ask again and do not wait.";
    },
    approve: async (tool, input, reason): Promise<PermissionResult> => {
      if (waits.consumeApproval(botId, tool, input))
        return { behavior: "allow", updatedInput: input };
      waits.open(botId, {
        kind: "tool_approval",
        payload: { tool, input, canonical: canonicalInput(input), reason },
        actions: approvalActions(tool, locked(tool)),
      });
      return {
        behavior: "deny",
        message: `The request to use ${tool} was sent to the owner, who is not watching this run. It was not allowed yet. End your turn now: do not retry and do not work around it. The answer will arrive later as a message in this conversation.`,
      };
    },
    attended: () => false,
  };
}
