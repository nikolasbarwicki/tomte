import type { MemoryScope } from "@tomte/contract/events";
import { createContext, use, useSyncExternalStore } from "react";

import { sessionStore } from "./session.ts";
import { emptyChat, emptyView, type BotView, type HostState } from "./state.ts";
import { hostStore } from "./store.ts";

// Private: selectors must read a field and never allocate, so each hook below stays stable between unrelated events.
const useHost = <T>(sel: (s: HostState) => T) =>
  useSyncExternalStore(hostStore.subscribe, () => sel(hostStore.get()));

/** The bot whose page is on screen. The bot route provides it; the per-bot hooks below read that bot's view. */
export const ShownBot = createContext<string | undefined>(undefined);

const useView = <T>(sel: (v: BotView) => T) => {
  const botId = use(ShownBot);
  return useHost((s) => sel((botId !== undefined && s.views[botId]) || emptyView));
};

export const useHostInfo = () => useHost((s) => s.info);
export const usePublicHostInfo = () => useHost((s) => s.publicInfo);
export const useBots = () => useHost((s) => s.bots);
export const useOpenBotId = () => useHost((s) => s.openBotId);
export const useChat = () => useView((v) => v.chat ?? emptyChat);
/** Whether the host has sent the shown bot's chat at least once. */
export const useChatLoaded = () => useView((v) => v.chat !== undefined);
export const useMemory = (scope: MemoryScope) => {
  const bot = useView((v) => v.memory);
  const user = useHost((s) => s.userMemory);
  return scope === "user" ? user : bot;
};
export const useFiles = () => useView((v) => v.files);
export const useRoutines = () => useView((v) => v.routines);
export const useWork = () => useView((v) => v.work);
export const useIntegrations = () => useHost((s) => s.integrations);

export const useSession = () => useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
