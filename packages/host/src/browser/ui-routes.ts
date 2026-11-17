import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type { Waits } from "../waits/index.ts";
import { toEngineInput } from "./input.ts";
import type { LiveView } from "./live-view.ts";
import type { Takeover } from "./takeover.ts";
import { BotRef, readUiBody, rejectRequest } from "./ui-request.ts";

const CONTROL_PATH = "/api/browser/control";
const INPUT_PATH = "/api/browser/input";
const WAIT_ANSWER_PATH = "/api/waits/answer";
export const BROWSER_UI_PATHS: ReadonlySet<string> = new Set([
  CONTROL_PATH,
  INPUT_PATH,
  WAIT_ANSWER_PATH,
]);

const ControlAction = z.object({ action: z.enum(["take", "hand_back"]) });
const WaitAnswer = z.object({ id: z.string(), action: z.string() });

export interface BrowserUiRoutesOptions {
  isEnabled(botId: string): boolean;
  takeover: Takeover;
  waits: Waits;
  liveView: LiveView;
}

const ok = (res: ServerResponse) =>
  void res.writeHead(200, { "content-type": "application/json" }).end("{}");

/**
 * The UI's browser routes that act: take control or hand back, send input, answer a wait card. They take POST with
 * a JSON body, like the live view. Input bodies are never logged, echoed or stored.
 */
export function createBrowserUiRoutes(o: BrowserUiRoutesOptions) {
  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    const body = await readUiBody(req, res);
    if (!body) return;

    if (path === WAIT_ANSWER_PATH) {
      const answer = WaitAnswer.safeParse(body);
      // Takeover cards only: questions and approvals are answered through /api/answer.
      const kind = answer.success ? o.waits.find(answer.data.id)?.kind : undefined;
      const answered =
        answer.success && kind === "takeover" && o.waits.answer(answer.data.id, answer.data.action);
      return answered ? ok(res) : rejectRequest(res, 404, "no such pending request");
    }
    const ref = BotRef.safeParse(body);
    if (!ref.success) return rejectRequest(res, 400, "botId required");
    const { botId } = ref.data;
    if (!o.isEnabled(botId))
      return rejectRequest(res, 403, "the browser is switched off for this bot");

    if (path === CONTROL_PATH) {
      const control = ControlAction.safeParse(body);
      if (!control.success) return rejectRequest(res, 400, "action must be take or hand_back");
      if (control.data.action === "hand_back") return (o.takeover.handBack(botId), ok(res));
      try {
        await o.takeover.start(botId);
      } catch (e) {
        return rejectRequest(res, 409, (e as Error).message);
      }
      return ok(res);
    }

    // INPUT_PATH
    if (!o.takeover.accepts(botId))
      return rejectRequest(res, 409, "you do not have control of this browser");
    const message = toEngineInput(body);
    if (!message) return rejectRequest(res, 400, "invalid input event");
    if (!o.liveView.sendInput(botId, message))
      return rejectRequest(res, 409, "the browser is not running");
    o.takeover.touch(botId);
    ok(res);
  };
}
