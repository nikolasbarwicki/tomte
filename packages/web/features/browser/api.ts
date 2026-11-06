import { act, post } from "@/host/api.ts";

export const setBrowserEnabled = (botId: string, enabled: boolean) =>
  act("/api/bots/browser", { botId, enabled });

export const setBrowserHeaded = (botId: string, headed: boolean) =>
  act("/api/bots/browser/headed", { botId, headed });

export const restartBrowser = (botId: string) => act("/api/bots/browser/restart", { botId });

export const signOutBrowser = (botId: string) => act("/api/bots/browser/sign-out", { botId });

/** The user takes the browser from the bot, or hands it back. */
export const controlBrowser = (botId: string, action: "take" | "hand_back") =>
  post("/api/browser/control", { botId, action });

/** The last input event still on its way; the next one waits for it so the bot's browser gets them in the order they happened. */
let inputInFlight: Promise<void> = Promise.resolve();

/** Forwards a pointer or key event from the live view, one at a time and in order (parallel requests overtake each other and scramble typed text); failures are dropped. */
export const sendBrowserInput = (botId: string, event: Record<string, unknown>) => {
  inputInFlight = inputInFlight
    .then(() => post("/api/browser/input", { botId, ...event }))
    .then(
      () => undefined,
      () => undefined,
    );
};
