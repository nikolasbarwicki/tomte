/** Whether this browser holds a device token the host accepts; `unknown` until the first request answers. */
type SessionState = "unknown" | "paired" | "unpaired";

export type SessionStore = {
  get: () => SessionState;
  subscribe: (listener: () => void) => () => void;
  set: (state: SessionState) => void;
};

export function createSessionStore(): SessionStore {
  let state: SessionState = "unknown";
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next) {
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

/** The page's one pairing state. The cookie is HttpOnly, so the page learns it only from the host's answers. */
export const sessionStore = createSessionStore();
