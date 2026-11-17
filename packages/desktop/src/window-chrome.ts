import type { BrowserWindowConstructorOptions } from "electron";

/**
 * Height in pixels of the Window Controls Overlay. On macOS Electron centres the traffic lights in it, so it is the web
 * UI's top bar (`AppBar`, `h-10`, the top row of the content sheet that starts 8px below the window's top) plus 8px
 * above and below: the lights and the bar share one centre line.
 */
export const TITLE_BAR_HEIGHT = 56;

/**
 * The main window's chrome. On macOS the OS title strip goes away and the real traffic lights float over the page, which
 * learns where they are through the standard Window Controls Overlay (`navigator.windowControlsOverlay`, CSS
 * `env(titlebar-area-*)`). Every other platform keeps the default frame.
 */
export function windowChrome(
  platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay"> {
  if (platform !== "darwin") return {};
  return { titleBarStyle: "hidden", titleBarOverlay: { height: TITLE_BAR_HEIGHT } };
}
