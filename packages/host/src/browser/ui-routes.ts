import type { IncomingMessage, ServerResponse } from "node:http";

import type { HostOrigin } from "../platform/config.ts";
import type { HumanWaits } from "./human-waits.ts";
import { toEngineInput } from "./input.ts";
import type { LiveView } from "./live-view.ts";
import type { Takeover } from "./takeover.ts";
import { guardUiRequest, rejectRequest } from "./ui-guard.ts";

const CONTROL_PATH = "/api/browser/control";
const INPUT_PATH = "/api/browser/input";
const WAIT_ANSWER_PATH = "/api/waits/answer";
export const BROWSER_UI_PATHS: ReadonlySet<string> = new Set([
  CONTROL_PATH,
  INPUT_PATH,
  WAIT_ANSWER_PATH,
]);

export interface BrowserUiRoutesOptions {
  host: HostOrigin;
  isEnabled(botId: string): boolean;
  takeover: Takeover;
  waits: HumanWaits;
  liveView: LiveView;
}

const ok = (res: ServerResponse) =>
  void res.writeHead(200, { "content-type": "application/json" }).end("{}");

/**
 * The UI's browser routes that act: take control or hand back, send input, answer a wait card. They share the
 * live view's checks (own Host and Origin, JSON). Input bodies are never logged, echoed or stored.
 */
export function createBrowserUiRoutes(o: BrowserUiRoutesOptions) {
  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    const body = await guardUiRequest(req, res, o.host);
    if (!body) return;
    const botId = typeof body.botId === "string" ? body.botId : "";

    if (path === WAIT_ANSWER_PATH) {
      const answered =
        typeof body.id === "string" &&
        typeof body.action === "string" &&
        o.waits.answer(body.id, body.action);
      return answered ? ok(res) : rejectRequest(res, 404, "no such pending request");
    }
    if (!botId) return rejectRequest(res, 400, "botId required");
    if (!o.isEnabled(botId))
      return rejectRequest(res, 403, "the browser is switched off for this bot");

    if (path === CONTROL_PATH) {
      if (body.action === "hand_back") return (o.takeover.handBack(botId), ok(res));
      if (body.action !== "take")
        return rejectRequest(res, 400, "action must be take or hand_back");
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
