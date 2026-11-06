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

/** Forwards a pointer or key event from the live view; failures are dropped. */
export const sendBrowserInput = (botId: string, event: Record<string, unknown>) =>
  void post("/api/browser/input", { botId, ...event }).catch(() => undefined);
