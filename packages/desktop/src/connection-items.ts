import type { MenuItemConstructorOptions } from "electron";

import type { ProfileView } from "./connections.ts";

/** Which side to update, as the tray and the Connections page word it. */
export const UPDATE_LABEL = { "update-host": "update host", "update-app": "update app" } as const;

export interface ConnectionActions {
  connect(id: string): void;
  manage(): void;
}

/** One radio item per profile, the active one checked, then Manage Connections…. Shared by the application menu's Connections submenu and the tray. */
export function connectionItems(
  profiles: ProfileView[],
  actions: ConnectionActions,
): MenuItemConstructorOptions[] {
  return [
    ...profiles.map((profile): MenuItemConstructorOptions => ({
      label: profile.update ? `${profile.name} (${UPDATE_LABEL[profile.update]})` : profile.name,
      type: "radio",
      checked: profile.active,
      click: () => actions.connect(profile.id),
    })),
    { type: "separator" },
    { label: "Manage Connections…", click: () => actions.manage() },
  ];
}
