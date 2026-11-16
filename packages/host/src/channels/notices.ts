import { z } from "zod";

import { cut, linkTo } from "./cards/compose.ts";
import type { ChannelMessage } from "./types.ts";

/** How much of a failed run's error a notice keeps. */
const MAX_ERROR = 300;

/**
 * A message the host sends the linked account on its own account, outside the needs-you cards: it has no buttons beyond the link to the
 * web UI and is not tracked after it is sent. A new kind (a routine's result) is a new member here and a new case in `noticeMessage`.
 */
export const Notice = z.discriminatedUnion("kind", [
  /** A routine run that failed, or that the host's stopping interrupted (`interrupted`). */
  z.object({
    kind: z.literal("run_failed"),
    botId: z.string(),
    routine: z.string(),
    error: z.string(),
    interrupted: z.boolean(),
  }),
  /** A parked run's wait went 24 hours unanswered, so the run failed; `wait` says what it was waiting for. */
  z.object({
    kind: z.literal("park_expired"),
    botId: z.string(),
    routine: z.string(),
    wait: z.string(),
  }),
]);
export type Notice = z.output<typeof Notice>;

/** The notice as one plain message, with a link to the bot's Routines panel unless the public URL is a loopback `http` one. */
export function noticeMessage(notice: Notice, publicUrl: string): ChannelMessage {
  const link = linkTo(publicUrl, { botId: notice.botId, panel: "routines" });
  const text = (() => {
    switch (notice.kind) {
      case "run_failed":
        return `Routine ${notice.routine} ${notice.interrupted ? "was interrupted" : "failed"}: ${cut(notice.error, MAX_ERROR)}`;
      case "park_expired":
        return `${notice.routine}: ${notice.wait} expired, so the run failed`;
    }
  })();
  return { text, ...(link && { link }) };
}
