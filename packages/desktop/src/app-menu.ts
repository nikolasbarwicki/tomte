import { Menu, type MenuItemConstructorOptions } from "electron";

import { connectionItems } from "./connection-items.ts";
import type { DesktopConnections } from "./desktop-connections.ts";

/** The application menu: Electron's standard menus plus Connections, one radio item per profile and Manage Connections…. Rebuilt whenever the profiles or the active one change. */
export function installAppMenu(connections: DesktopConnections): void {
  async function rebuild(): Promise<void> {
    const profiles = await connections.list();
    const template: MenuItemConstructorOptions[] = [
      process.platform === "darwin" ? { role: "appMenu" } : { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      {
        label: "Connections",
        submenu: connectionItems(profiles, {
          connect: (id) => void connections.connect(id).then(rebuild),
          manage: () => connections.openConnections(),
        }),
      },
      { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  connections.onChange(() => void rebuild());
  void rebuild();
}
