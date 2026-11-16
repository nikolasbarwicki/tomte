import type { Notice } from "../channels/index.ts";
import type { RunEnd } from "../routines/index.ts";

/**
 * The notice a run that ended is owed, if any: a failure (or an interruption by the host stopping) always, whatever the routine's settings;
 * a park that expired is its own notice and not also a failure. A run that succeeded is owed its result only when its routine has
 * `notifyResult` on now (`routine` is read when the run ends, so a switch-off before then sends nothing).
 */
export function runNotice({ run, routine, expired }: RunEnd): Notice | undefined {
  const { botId, name } = routine;
  if (expired.length > 0 && run.status === "failed")
    return { kind: "park_expired", botId, routine: name, wait: expired[0]! };
  if (run.status === "failed" || run.status === "interrupted")
    return {
      kind: "run_failed",
      botId,
      routine: name,
      error: run.error ?? "no reason recorded",
      interrupted: run.status === "interrupted",
    };
  if (run.status === "succeeded" && routine.notifyResult)
    return { kind: "routine_result", botId, routine: name, output: run.output ?? "" };
  return undefined;
}
