import { describe, expect, test } from "bun:test";

import { createLocalHostPolicy, localWanted, type LocalHostAnswer } from "./local-policy.ts";
import type { DesktopSettings, SettingsStore } from "./settings.ts";

describe("localWanted", () => {
  test("every setting against This computer and a server", () => {
    const table: [DesktopSettings["localHost"], string, boolean][] = [
      [undefined, "local", true],
      [undefined, "p1", true],
      ["always", "local", true],
      ["always", "p1", true],
      ["while-shown", "local", true],
      ["while-shown", "p1", false],
    ];
    for (const [setting, shown, wanted] of table) expect(localWanted(setting, shown)).toBe(wanted);
  });
});

const local = { id: "local", name: "This computer" };
const vps = { id: "p1", name: "my-vps" };
const other = { id: "p2", name: "office" };

function setup(initial: DesktopSettings["localHost"], answers: LocalHostAnswer[] = []) {
  let current: DesktopSettings = { startAtLogin: true, localHost: initial };
  const settings: SettingsStore = {
    get: () => current,
    update: (patch) => void (current = { ...current, ...patch }),
  };
  const wants: boolean[] = [];
  const asked: string[] = [];
  let visible = true;
  const policy = createLocalHostPolicy({
    settings,
    supervisor: { want: async (running) => void wants.push(running) },
    async ask(name) {
      asked.push(name);
      return answers.shift() ?? "later";
    },
    canAsk: () => visible,
  });
  return {
    policy,
    settings,
    wants,
    asked,
    hide: () => (visible = false),
    show: () => (visible = true),
  };
}

describe("the local host policy", () => {
  test("before an answer the host runs, whatever is shown, and the first server asks the question once", async () => {
    const w = setup(undefined, ["while-shown"]);
    await w.policy.reconcile(local);
    await w.policy.reconcile(vps);
    expect(w.asked).toEqual(["my-vps"]);
    expect(w.settings.get().localHost).toBe("while-shown");
    expect(w.wants).toEqual([true, false]);
  });

  test("keeping it running is an answer too, and nothing pauses", async () => {
    const w = setup(undefined, ["always"]);
    await w.policy.reconcile(vps);
    await w.policy.reconcile(local);
    await w.policy.reconcile(vps);
    expect(w.asked).toEqual(["my-vps"]);
    expect(w.settings.get().localHost).toBe("always");
    expect(w.wants).toEqual([true]);
  });

  test("an answered question is never asked again", async () => {
    const w = setup("while-shown");
    await w.policy.reconcile(vps);
    await w.policy.reconcile(local);
    await w.policy.reconcile(vps);
    expect(w.asked).toEqual([]);
    expect(w.wants).toEqual([false, true, false]);
  });

  test("a deferred question is not asked again for the same server, only after This computer was shown", async () => {
    const w = setup(undefined, ["later", "later", "always"]);
    await w.policy.reconcile(vps);
    await w.policy.reconcile(vps);
    await w.policy.refresh();
    expect(w.asked).toEqual(["my-vps"]);
    await w.policy.reconcile(local);
    await w.policy.reconcile(other);
    await w.policy.reconcile(local);
    await w.policy.reconcile(vps);
    expect(w.asked).toEqual(["my-vps", "office", "my-vps"]);
    expect(w.settings.get().localHost).toBe("always");
    expect(w.wants).toEqual([true]);
  });

  test("a hidden window gets no question until it is shown", async () => {
    const w = setup(undefined, ["while-shown"]);
    w.hide();
    await w.policy.reconcile(vps);
    expect(w.asked).toEqual([]);
    expect(w.wants).toEqual([true]);
    w.show();
    await w.policy.refresh();
    expect(w.asked).toEqual(["my-vps"]);
    expect(w.wants).toEqual([true, false]);
  });

  test("the host keeps running while the question is open", async () => {
    const answer = Promise.withResolvers<LocalHostAnswer>();
    const wants: boolean[] = [];
    let current: DesktopSettings = { startAtLogin: true };
    const policy = createLocalHostPolicy({
      settings: {
        get: () => current,
        update: (patch) => void (current = { ...current, ...patch }),
      },
      supervisor: { want: async (running) => void wants.push(running) },
      ask: () => answer.promise,
      canAsk: () => true,
    });
    const pending = policy.reconcile(vps);
    await Bun.sleep(1);
    expect(wants).toEqual([true]);
    await policy.reconcile(vps);
    answer.resolve("while-shown");
    await pending;
    expect(wants).toEqual([true, false]);
  });

  test("changing the setting later, as the tray does, applies to what is shown", async () => {
    const w = setup("always");
    await w.policy.reconcile(vps);
    expect(w.wants).toEqual([true]);
    w.settings.update({ localHost: "while-shown" });
    await w.policy.refresh();
    expect(w.wants).toEqual([true, false]);
    w.settings.update({ localHost: "always" });
    await w.policy.refresh();
    expect(w.wants).toEqual([true, false, true]);
  });

  test("an unrelated change does not repeat the wish", async () => {
    const w = setup("while-shown");
    await w.policy.reconcile(vps);
    await w.policy.reconcile(vps);
    await w.policy.refresh();
    expect(w.wants).toEqual([false]);
  });
});
