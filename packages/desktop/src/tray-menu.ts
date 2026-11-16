import type { MenuItemConstructorOptions } from "electron";

import { connectionItems } from "./connection-items.ts";
import type { ProfileView } from "./connections.ts";
import type { HostState } from "./supervisor.ts";

export interface TrayActions {
  open(): void;
  setStartAtLogin(enabled: boolean): void;
  restartHost(): void;
  quit(): void;
  connect(id: string): void;
  manageConnections(): void;
  restartToUpdate(): void;
}

export function hostStatusText(state: HostState): string {
  switch (state.status) {
    case "starting":
      return "Claudebot: host starting";
    case "running":
      return "Claudebot: host running";
    case "stopped":
      return "Claudebot: host stopped";
  }
}

/** The tray's menu for the current state. The same items back the real menu and what a smoke test reads. `readyUpdate` is the version of a downloaded update, which adds a "Restart to update" item. */
export function trayMenu(
  state: HostState,
  startAtLogin: boolean,
  profiles: ProfileView[],
  readyUpdate: string | undefined,
  actions: TrayActions,
): MenuItemConstructorOptions[] {
  return [
    { label: hostStatusText(state), enabled: false },
    ...(state.status === "stopped"
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
    { label: "Open Claudebot", click: () => actions.open() },
    {
      label: "Start at login",
      type: "checkbox",
      checked: startAtLogin,
      click: () => actions.setStartAtLogin(!startAtLogin),
    },
    { type: "separator" },
    { label: "Quit Claudebot", click: () => actions.quit() },
  ];
}
