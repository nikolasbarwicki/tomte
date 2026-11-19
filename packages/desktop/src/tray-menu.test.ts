import { describe, expect, test } from "bun:test";

import type { HostLine } from "./host-lines.ts";
import type { DesktopSettings } from "./settings.ts";
import { trayMenu, trayTooltip, type TrayActions } from "./tray-menu.ts";

const running: HostLine[] = [{ id: "local", name: "This computer", state: "running", needsYou: 0 }];
const starting: HostLine[] = [
  { id: "local", name: "This computer", state: "starting", needsYou: 0 },
];
const stopped: HostLine[] = [{ id: "local", name: "This computer", state: "stopped", needsYou: 0 }];
const paused: HostLine[] = [{ id: "local", name: "This computer", state: "paused", needsYou: 0 }];
const profiles = [
  { id: "local", name: "This computer", origin: "http://127.0.0.1:1", active: false },
  { id: "p1", name: "Work", origin: "https://work.example.com", active: true },
];

function setup(
  hosts: readonly HostLine[],
  startAtLogin = true,
  readyUpdate?: string,
  localHost?: DesktopSettings["localHost"],
) {
  const calls: string[] = [];
  const actions: TrayActions = {
    open: () => void calls.push("open"),
    setStartAtLogin: (on) => void calls.push(`login ${on}`),
    setLocalHost: (setting) => void calls.push(`local host ${setting}`),
    restartHost: () => void calls.push("restart"),
    quit: () => void calls.push("quit"),
    connect: (id) => void calls.push(`connect ${id}`),
    manageConnections: () => void calls.push("manage"),
    restartToUpdate: () => void calls.push("update"),
  };
  const items = trayMenu(hosts, { startAtLogin, localHost }, profiles, readyUpdate, actions);
  const item = (label: string) => items.find((i) => i.label === label);
  const click = (label: string) => {
    const click = item(label)?.click as (() => void) | undefined;
    if (!click) throw new Error(`no ${label} item`);
    click();
  };
  return { items, item, click, calls };
}

describe("the tray menu", () => {
  test("leads with a disabled line per host, which is also the tooltip text", () => {
    for (const [hosts, text] of [
      [starting, "This computer: starting"],
      [running, "This computer: running"],
      [stopped, "This computer: stopped"],
      [paused, "This computer: paused"],
    ] as const) {
      expect(trayTooltip(hosts)).toBe(text);
      expect(setup(hosts).items[0]).toEqual({ label: text, enabled: false });
    }
  });

  test("renders two hosts with their counts and a problem", () => {
    const hosts: HostLine[] = [
      { id: "local", name: "This computer", state: "running", needsYou: 1 },
      {
        id: "p1",
        name: "my-vps",
        state: "connected",
        needsYou: 1,
        problem: { kind: "claude-signed-out" },
      },
    ];
    const menu = setup(hosts);
    expect(menu.items.slice(0, 2)).toEqual([
      { label: "This computer: running · 1 needs you", enabled: false },
      { label: "my-vps: connected · 1 needs you · Claude signed out", enabled: false },
    ]);
    expect(trayTooltip(hosts)).toBe(
      "This computer: running · 1 needs you\nmy-vps: connected · 1 needs you · Claude signed out",
    );
    expect(menu.item("Restart host")).toBeUndefined();
  });

  test("offers Restart host only while the host is stopped", () => {
    expect(setup(running).item("Restart host")).toBeUndefined();
    expect(setup(starting).item("Restart host")).toBeUndefined();
    const stoppedMenu = setup(stopped);
    stoppedMenu.click("Restart host");
    expect(stoppedMenu.calls).toEqual(["restart"]);
  });

  test("a paused host reads paused with no count, and has no Restart host: it starts when This computer is shown", () => {
    const hosts: HostLine[] = [
      { id: "local", name: "This computer", state: "paused", needsYou: 0 },
      { id: "p1", name: "my-vps", state: "connected", needsYou: 2 },
    ];
    const menu = setup(hosts, true, undefined, "while-shown");
    expect(menu.items.slice(0, 2)).toEqual([
      { label: "This computer: paused", enabled: false },
      { label: "my-vps: connected · 2 need you", enabled: false },
    ]);
    expect(menu.item("Restart host")).toBeUndefined();
  });

  test("Run this Mac's host is checked until the host is set to run only while This computer is shown, and a click asks for the other", () => {
    const unanswered = setup(running);
    expect(unanswered.item("Run this Mac's host")).toMatchObject({
      type: "checkbox",
      checked: true,
    });
    unanswered.click("Run this Mac's host");
    const always = setup(running, true, undefined, "always");
    expect(always.item("Run this Mac's host")).toMatchObject({ checked: true });
    always.click("Run this Mac's host");
    const whileShown = setup(paused, true, undefined, "while-shown");
    expect(whileShown.item("Run this Mac's host")).toMatchObject({ checked: false });
    whileShown.click("Run this Mac's host");
    expect([...unanswered.calls, ...always.calls, ...whileShown.calls]).toEqual([
      "local host while-shown",
      "local host while-shown",
      "local host always",
    ]);
  });

  test("Open and Quit call their actions", () => {
    const menu = setup(running);
    menu.click("Open Tomte");
    menu.click("Quit Tomte");
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
      "This computer: running",
      "-",
      "This computer",
      "Work",
      "-",
      "Manage Connections…",
      "-",
      "Open Tomte",
      "Start at login",
      "Run this Mac's host",
      "-",
      "Quit Tomte",
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
