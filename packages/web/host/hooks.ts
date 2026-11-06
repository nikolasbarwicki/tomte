import { useSyncExternalStore } from "react";

import type { HostState } from "./state.ts";
import { hostStore } from "./store.ts";

// Private: selectors must read a field and never allocate, so each hook below stays stable between unrelated events.
const useHost = <T>(sel: (s: HostState) => T) =>
  useSyncExternalStore(hostStore.subscribe, () => sel(hostStore.get()));

export const useHostInfo = () => useHost((s) => s.info);
export const useBots = () => useHost((s) => s.bots);
export const useOpenBotId = () => useHost((s) => s.openBotId);
export const useChat = () => useHost((s) => s.chat);
export const useMemory = () => useHost((s) => s.memory);
export const useFiles = () => useHost((s) => s.files);
export const useRoutines = () => useHost((s) => s.routines);
export const useIntegrations = () => useHost((s) => s.integrations);
export const useCredentials = () => useHost((s) => s.credentials);
export const useNotices = () => useHost((s) => s.notices);
