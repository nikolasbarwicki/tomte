import { applyEvent, initialHostState, type HostEvent, type HostState } from "./state.ts";

export type HostStore = {
  get(): HostState;
  subscribe(listener: () => void): () => void;
  dispatch(e: HostEvent): void;
};

function createHostStore(initial: HostState = initialHostState): HostStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispatch(e) {
      const next = applyEvent(state, e);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

/** The page's one host connection state. */
export const hostStore = createHostStore();
