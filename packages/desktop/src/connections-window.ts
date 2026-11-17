import { BrowserWindow, protocol, session } from "electron";

import {
  CONNECTIONS_ORIGIN,
  CONNECTIONS_SCHEME,
  type ConnectionsPages,
} from "./connections-page.ts";
import type { Navigation } from "./navigation.ts";

/** In memory (no `persist:` prefix) and apart from the default session, so no host page can reach the scheme and nothing the window does reaches disk. */
const PARTITION = "tomte-desktop-connections";

/** Must run before the app is ready: it is what lets the scheme load as a secure, standard origin. */
export function registerConnectionsScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: CONNECTIONS_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

export interface ConnectionsWindow {
  /** Shows the Connections window, focused, with the stored message `noticeId` if given. */
  open(noticeId?: string): void;
}

/** The Connections window: the same web preferences as the host window (sandbox, context isolation, no Node, no preload), its own session, and navigation pinned to its scheme. `parent` closing closes it. */
export function createConnectionsWindow(
  pages: ConnectionsPages,
  navigation: Navigation,
  parent: BrowserWindow,
): ConnectionsWindow {
  const partition = session.fromPartition(PARTITION);
  partition.protocol.handle(CONNECTIONS_SCHEME, (request) => pages.handle(request));
  navigation.pinSession(partition, CONNECTIONS_ORIGIN);

  let window: BrowserWindow | undefined;
  parent.on("closed", () => window?.close());

  return {
    open(noticeId) {
      const url = `${CONNECTIONS_ORIGIN}/${noticeId === undefined ? "" : `?m=${encodeURIComponent(noticeId)}`}`;
      if (window === undefined || window.isDestroyed()) {
        window = new BrowserWindow({
          width: 620,
          height: 720,
          title: "Connections",
          webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
          },
        });
        window.on("closed", () => (window = undefined));
      }
      void window.loadURL(url);
      if (window.isMinimized()) window.restore();
      window.focus();
    },
  };
}
