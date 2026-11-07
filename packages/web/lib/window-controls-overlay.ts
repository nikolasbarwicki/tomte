/** The Window Controls Overlay API (Electron on macOS, installed PWAs), which lib.dom does not declare. */
interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
}

declare global {
  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay;
  }
}

/**
 * Sets `data-wco` on the root element while the page runs under native window controls (the desktop app's hidden title
 * bar). The stylesheet makes the app's top bars drag regions only then, so a plain browser tab is unaffected; the
 * `env(titlebar-area-*)` insets need no script, they are 0 or unset everywhere else.
 */
export function trackWindowControlsOverlay(): void {
  const overlay = navigator.windowControlsOverlay;
  if (!overlay) return;
  const apply = () => document.documentElement.toggleAttribute("data-wco", overlay.visible);
  apply();
  overlay.addEventListener("geometrychange", apply);
}
