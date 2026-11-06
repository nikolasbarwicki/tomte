import { describe, expect, test } from "bun:test";

import { createSessionStore } from "./session.ts";

describe("session store", () => {
  test("starts unknown and notifies only when the state changes", () => {
    const store = createSessionStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified++);
    expect(store.get()).toBe("unknown");
    store.set("unpaired");
    store.set("unpaired");
    store.set("paired");
    expect([store.get(), notified]).toEqual(["paired", 2]);
    unsubscribe();
    store.set("unpaired");
    expect(notified).toBe(2);
  });
});
