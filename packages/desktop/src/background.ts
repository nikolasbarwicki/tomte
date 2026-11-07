import { app, type BrowserWindow } from "electron";

export interface Background {
  /** Shows the window, restores it from the dock and brings it to the front. */
  reveal(): void;
  visible(): boolean;
}

/** Closing the window hides it and the app keeps running in the tray, until the app is quitting. On macOS the dock icon is hidden while the window is. */
export function keepInTray(window: BrowserWindow, isQuitting: () => boolean): Background {
  window.on("close", (event) => {
    if (isQuitting()) return;
    event.preventDefault();
    window.hide();
  });
  // The dock icon is shown at launch, so only a hidden one needs `show()`. That call resolves later than it is made and a `hide()` issued meanwhile would be undone by it, so the calls run in order.
  let dockHidden = false;
  let dock = Promise.resolve();
  const setDock = (visible: boolean) => {
    if (visible !== dockHidden) return;
    dockHidden = !visible;
    dock = dock.then(async () => {
      if (visible) await app.dock?.show();
      else app.dock?.hide();
    });
  };
  window.on("hide", () => setDock(false));
  window.on("show", () => setDock(true));
  if (!window.isVisible()) setDock(false);
  return {
    reveal() {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      app.focus({ steal: true });
    },
    visible: () => window.isVisible(),
  };
}
