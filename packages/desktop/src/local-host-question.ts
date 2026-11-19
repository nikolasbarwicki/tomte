import { dialog, type BrowserWindow } from "electron";

import { LOCAL_HOST_QUESTION_ENV, type LocalHostAnswer } from "./local-policy.ts";

/** The one-time question, as the main process holds it. A smoke of the packaged app replaces `ask` (through `desktop.localHostQuestion` in `main.ts`) to answer without an OS dialog, as it does for the needs-you banner's `Notifier`. */
export interface LocalHostQuestion {
  ask(serverName: string): Promise<LocalHostAnswer>;
}

/** A native message box over the window. Closing it with Escape is "Ask me later", never an answer. */
export function createLocalHostQuestion(
  window: BrowserWindow,
  env: Record<string, string | undefined>,
): LocalHostQuestion {
  return {
    async ask(serverName) {
      if (env[LOCAL_HOST_QUESTION_ENV] === "off") return "later";
      const answers: LocalHostAnswer[] = ["always", "while-shown", "later"];
      const { response } = await dialog.showMessageBox(window, {
        type: "question",
        message: `Keep bots on this Mac running while you use ${serverName}?`,
        detail:
          "The bots on this Mac keep working while you use a server, so their routines still fire. " +
          `If you pause them, this Mac's host stops while ${serverName} is shown and starts again when ` +
          "you show This computer; nothing is deleted or moved. Change it later in the menu bar " +
          "icon's menu: Run this Mac's host.",
        buttons: ["Keep running", "Pause while I use a server", "Ask me later"],
        defaultId: 0,
        cancelId: 2,
      });
      return answers[response] ?? "later";
    },
  };
}
