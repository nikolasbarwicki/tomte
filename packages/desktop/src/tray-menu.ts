import type { MenuItemConstructorOptions } from "electron";

import { connectionItems } from "./connection-items.ts";
import type { ProfileView } from "./connections.ts";
import { hostLineText, type HostLine } from "./host-lines.ts";
import { LOCAL_ID } from "./profile-store.ts";
import type { DesktopSettings, LocalHostSetting } from "./settings.ts";

export interface TrayActions {
  open(): void;
  setStartAtLogin(enabled: boolean): void;
  setLocalHost(setting: LocalHostSetting): void;
  restartHost(): void;
  quit(): void;
  connect(id: string): void;
  manageConnections(): void;
  restartToUpdate(): void;
}

/** The tray's tooltip: the same lines as the menu's first items. */
export function trayTooltip(hosts: readonly HostLine[]): string {
  return hosts.map(hostLineText).join("\n");
}

/** The tray's menu for the current hosts: one disabled line each, then the rest. The same items back the real menu and what a smoke test reads. `readyUpdate` is the version of a downloaded update, which adds a "Restart to update" item. "Run this Mac's host" is checked unless the host runs only while This computer is shown (no answer yet runs it); a paused host has no "Restart host", it starts when This computer is shown or the item is checked. */
export function trayMenu(
  hosts: readonly HostLine[],
  settings: DesktopSettings,
  profiles: ProfileView[],
  readyUpdate: string | undefined,
  actions: TrayActions,
): MenuItemConstructorOptions[] {
  return [
    ...hosts.map((line): MenuItemConstructorOptions => ({
      label: hostLineText(line),
      enabled: false,
    })),
    ...(hosts.some((line) => line.id === LOCAL_ID && line.state === "stopped")
      ? [{ label: "Restart host", click: () => actions.restartHost() }]
      : []),
    { type: "separator" },
    ...connectionItems(profiles, {
      connect: (id) => actions.connect(id),
      manage: () => actions.manageConnections(),
    }),
    { type: "separator" },
    ...(readyUpdate === undefined
      ? []
      : [
          {
            label: `Restart to update to ${readyUpdate}`,
            click: () => actions.restartToUpdate(),
          },
        ]),
    { label: "Open Tomte", click: () => actions.open() },
    {
      label: "Start at login",
      type: "checkbox",
      checked: settings.startAtLogin,
      click: () => actions.setStartAtLogin(!settings.startAtLogin),
    },
    {
      label: "Run this Mac's host",
      type: "checkbox",
      checked: settings.localHost !== "while-shown",
      click: () =>
        actions.setLocalHost(settings.localHost === "while-shown" ? "always" : "while-shown"),
    },
    { type: "separator" },
    { label: "Quit Tomte", click: () => actions.quit() },
  ];
}
