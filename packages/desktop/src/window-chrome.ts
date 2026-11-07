import type { BrowserWindowConstructorOptions } from "electron";

/**
 * Height in pixels of the web UI's top bar (`AppBar` is `h-14`). On macOS Electron centres the traffic lights in a
 * Window Controls Overlay of this height, so the two must stay equal.
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
