import { join } from "node:path";

import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";

import type { ProfileView } from "./connections.ts";
import type { HostLine } from "./host-lines.ts";
import type { DesktopSettings } from "./settings.ts";
import { trayMenu, trayTooltip, type TrayActions } from "./tray-menu.ts";

export interface DesktopTray {
  /** Shows a line per host, the profiles (the active one checked), the desktop settings (Start at login, Run this Mac's host) and a downloaded update's version in the tooltip and the menu. */
  update(
    hosts: readonly HostLine[],
    settings: DesktopSettings,
    profiles: ProfileView[],
    readyUpdate: string | undefined,
  ): void;
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
    update(hosts, settings, profiles, readyUpdate) {
      current = {
        tooltip: trayTooltip(hosts),
        items: trayMenu(hosts, settings, profiles, readyUpdate, actions),
      };
      tray.setToolTip(current.tooltip);
      tray.setContextMenu(Menu.buildFromTemplate(current.items));
    },
    snapshot: () => current,
  };
}
