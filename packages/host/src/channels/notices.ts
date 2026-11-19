import { HostProblem, updateFailedText } from "@tomte/contract/host-status";
import { z } from "zod";

import { cut, linkTo, webLink } from "./cards/compose.ts";
import type { ChannelMessage } from "./types.ts";

/** How much of a failed run's error a notice keeps. */
const MAX_ERROR = 300;
/** How much of a succeeded run's output a result notice keeps. */
const MAX_RESULT = 800;

/**
 * A message the host sends the linked account on its own account, outside the needs-you cards: it has no buttons beyond the link to the
 * web UI and is not tracked after it is sent. A new kind is a new member here and a new case in `noticeMessage`.
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
  /** A run of a routine that opted in succeeded; `output` is the run's final summary, empty when it left none. */
  z.object({
    kind: z.literal("routine_result"),
    botId: z.string(),
    routine: z.string(),
    output: z.string(),
  }),
  /** Something is wrong with the host itself, whichever bot is open; sent once when the problem appears. `hostName` is how the owner knows this host. */
  z.object({ kind: z.literal("host_problem"), hostName: z.string(), problem: HostProblem }),
]);
export type Notice = z.output<typeof Notice>;

/** The notice as one plain message, with a link to where it can be dealt with (a bot's Routines panel, or Settings for the host) unless the public URL is a loopback `http` one. */
export function noticeMessage(notice: Notice, publicUrl: string): ChannelMessage {
  if (notice.kind === "host_problem") {
    const link = webLink(
      publicUrl,
      notice.problem.kind === "update-failed" ? "/settings/about" : "/settings/models",
    );
    return { text: hostProblemText(notice), ...(link && { link }) };
  }
  const link = linkTo(publicUrl, { botId: notice.botId, panel: "routines" });
  const text = (() => {
    switch (notice.kind) {
      case "run_failed":
        return `Routine ${notice.routine} ${notice.interrupted ? "was interrupted" : "failed"}: ${cut(notice.error, MAX_ERROR)}`;
      case "park_expired":
        return `${notice.routine}: ${notice.wait} expired, so the run failed`;
      case "routine_result": {
        const output = notice.output.trim();
        return output
          ? `${notice.routine}: ${cut(output, MAX_RESULT)}`
          : `${notice.routine} finished`;
      }
    }
  })();
  return { text, ...(link && { link }) };
}

function hostProblemText({ hostName, problem }: Extract<Notice, { kind: "host_problem" }>): string {
  switch (problem.kind) {
    case "claude-signed-out":
      return problem.reason === "token-rejected"
        ? `${hostName}: Claude rejected the long-lived token, so no bot there can run. Replace it in Settings, Models.`
        : `${hostName}: Claude is signed out, so no bot there can run. Sign in from Settings, Models.`;
    case "update-failed":
      return `${hostName}: ${updateFailedText(problem)}. Details are in Settings, About.`;
  }
}
