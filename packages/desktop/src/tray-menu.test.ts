import { describe, expect, test } from "bun:test";

import type { Sidecar } from "./sidecar.ts";
import type { HostState } from "./supervisor.ts";
import { hostStatusText, trayMenu, type TrayActions } from "./tray-menu.ts";

const running: HostState = { status: "running", sidecar: {} as Sidecar };
const stopped: HostState = { status: "stopped", reason: "exited" };
const profiles = [
  { id: "local", name: "This computer", origin: "http://127.0.0.1:1", active: false },
  { id: "p1", name: "Work", origin: "https://work.example.com", active: true },
];

function setup(state: HostState, startAtLogin = true, readyUpdate?: string) {
  const calls: string[] = [];
  const actions: TrayActions = {
    open: () => void calls.push("open"),
    setStartAtLogin: (on) => void calls.push(`login ${on}`),
    restartHost: () => void calls.push("restart"),
    quit: () => void calls.push("quit"),
    connect: (id) => void calls.push(`connect ${id}`),
    manageConnections: () => void calls.push("manage"),
    restartToUpdate: () => void calls.push("update"),
  };
  const items = trayMenu(state, startAtLogin, profiles, readyUpdate, actions);
  const item = (label: string) => items.find((i) => i.label === label);
  const click = (label: string) => {
    const click = item(label)?.click as (() => void) | undefined;
    if (!click) throw new Error(`no ${label} item`);
    click();
  };
  return { items, item, click, calls };
}

describe("the tray menu", () => {
  test("leads with the host state as a disabled item, which is also the tooltip text", () => {
    for (const [state, text] of [
      [{ status: "starting" }, "Claudebot: host starting"],
      [running, "Claudebot: host running"],
      [stopped, "Claudebot: host stopped"],
    ] as const) {
      expect(hostStatusText(state)).toBe(text);
      expect(setup(state).items[0]).toEqual({ label: text, enabled: false });
    }
  });

  test("offers Restart host only while the host is stopped", () => {
    expect(setup(running).item("Restart host")).toBeUndefined();
    expect(setup({ status: "starting" }).item("Restart host")).toBeUndefined();
    const stoppedMenu = setup(stopped);
    stoppedMenu.click("Restart host");
    expect(stoppedMenu.calls).toEqual(["restart"]);
  });

  test("Open and Quit call their actions", () => {
    const menu = setup(running);
    menu.click("Open Claudebot");
    menu.click("Quit Claudebot");
    expect(menu.calls).toEqual(["open", "quit"]);
  });

  test("the Start at login checkbox shows the setting and a click asks for the opposite", () => {
    const on = setup(running, true);
    expect(on.item("Start at login")).toMatchObject({ type: "checkbox", checked: true });
    on.click("Start at login");
    const off = setup(running, false);
    expect(off.item("Start at login")).toMatchObject({ checked: false });
    off.click("Start at login");
    expect([...on.calls, ...off.calls]).toEqual(["login false", "login true"]);
  });

  test("lists the profiles as radios between the host state and Open, and clicking one connects it", () => {
    const menu = setup(running);
    const labels = menu.items.map((i) => i.label ?? "-");
    expect(labels).toEqual([
      "Claudebot: host running",
      "-",
      "This computer",
      "Work",
      "-",
      "Manage Connections…",
      "-",
      "Open Claudebot",
      "Start at login",
      "-",
      "Quit Claudebot",
    ]);
    expect(menu.item("Work")).toMatchObject({ type: "radio", checked: true });
    expect(menu.item("This computer")).toMatchObject({ type: "radio", checked: false });
    menu.click("This computer");
    menu.click("Manage Connections…");
    expect(menu.calls).toEqual(["connect local", "manage"]);
  });
});

describe("the update item", () => {
  test("appears only once an update is downloaded, names its version and asks to restart", () => {
    expect(setup(running).item("Restart to update to 0.2.0")).toBeUndefined();
    const menu = setup(running, true, "0.2.0");
    menu.click("Restart to update to 0.2.0");
    expect(menu.calls).toEqual(["update"]);
  });
});
