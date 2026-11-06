import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { FINAL_STATUSES, type Handoff } from "../store.ts";
import type { BotsToolContext } from "./context.ts";
import { errorResult } from "./result.ts";

/** Which party may act: only the requester, only the assignee, or either. */
export type HandoffRole = "requester" | "assignee" | "party";

/** The open handoff `handoffId` if the caller may act on it in `role`; otherwise a tool error with a plain reason. */
export function openHandoffFor(
  ctx: BotsToolContext,
  handoffId: string,
  role: HandoffRole,
): { handoff: Handoff } | { error: CallToolResult } {
  const h = ctx.handoffs.get(handoffId);
  const isRequester = h?.requesterId === ctx.botId;
  const isAssignee = h?.assigneeId === ctx.botId;
  if (!h || (!isRequester && !isAssignee))
    return { error: errorResult(`no handoff ${handoffId} where you are a party`) };
  if (role === "requester" && !isRequester)
    return { error: errorResult(`only the requester of handoff ${handoffId} can do this`) };
  if (role === "assignee" && !isAssignee)
    return { error: errorResult(`only the assignee of handoff ${handoffId} can do this`) };
  if (FINAL_STATUSES.includes(h.status))
    return { error: errorResult(`handoff ${handoffId} is already ${h.status}`) };
  return { handoff: h };
}
