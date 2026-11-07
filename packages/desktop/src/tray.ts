import { join } from "node:path";

import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";

import type { ProfileView } from "./connections.ts";
import type { HostState } from "./supervisor.ts";
import { hostStatusText, trayMenu, type TrayActions } from "./tray-menu.ts";

export interface DesktopTray {
  /** Shows the state, the profiles (the active one checked) and the Start at login choice in the tooltip and the menu. */
  update(state: HostState, startAtLogin: boolean, profiles: ProfileView[]): void;
  /** What the tray shows now: the tooltip and the menu items, whose `click` is what the real menu calls. */
  snapshot(): { tooltip: string; items: MenuItemConstructorOptions[] };
}

/** The one tray icon. The image is a template image (`trayTemplate.png` with its `@2x`), which macOS tints for the menu bar. */
export function createTray(assetsDir: string, actions: TrayActions): DesktopTray {
  const image = nativeImage.createFromPath(join(assetsDir, "trayTemplate.png"));
  image.setTemplateImage(true);
  const tray = new Tray(image);
  let current = { tooltip: "", items: [] as MenuItemConstructorOptions[] };
  return {
    update(state, startAtLogin, profiles) {
      current = {
        tooltip: hostStatusText(state),
        items: trayMenu(state, startAtLogin, profiles, actions),
      };
      tray.setToolTip(current.tooltip);
      tray.setContextMenu(Menu.buildFromTemplate(current.items));
    },
    snapshot: () => current,
  };
}
