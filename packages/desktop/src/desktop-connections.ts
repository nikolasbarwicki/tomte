import { hostname } from "node:os";

import { net, type BrowserWindow } from "electron";

import { createConnectionsPages } from "./connections-page.ts";
import { createConnectionsWindow } from "./connections-window.ts";
import { createConnections, type ProfileView } from "./connections.ts";
import { createHostClient } from "./host-api.ts";
import type { Navigation } from "./navigation.ts";
import { createProfileStore } from "./profile-store.ts";
import { logTail } from "./sidecar.ts";
import type { HostState } from "./supervisor.ts";
import { createSafeStorageVault } from "./token-vault.ts";
import { showHostStopped, showStarting, signIn } from "./window.ts";

/** What the application menu and the tray use: the profiles, switching, and the manager window. */
export interface DesktopConnections {
  list(): Promise<ProfileView[]>;
  /** Connects like the Connections page does; a failure opens that window with the error instead of rejecting. */
  connect(id: string): Promise<void>;
  openConnections(): void;
  /** Connects to the saved active profile; when that fails, shows this computer and opens the Connections window with the reason. */
  start(): Promise<void>;
  /** The local host started, stopped or restarted: when `local` is the connection shown, shows it again as it now is. */
  localChanged(): Promise<void>;
  onChange(listener: () => void): void;
}

/** Wires profiles to the app: the store in `userData`, requests through the default session's `net.fetch` (Chromium's network stack and certificate checks), and the window the host UI shows in. */
export function setupConnections(options: {
  window: BrowserWindow;
  /** The local host's state now: the supervisor's, which changes when the host restarts. */
  local: () => HostState;
  /** The host's log, whose end the "not running" page shows. */
  logFile: string;
  navigation: Navigation;
  userData: string;
}): DesktopConnections {
  const { window, navigation } = options;
  const connections = createConnections({
    store: createProfileStore(options.userData, createSafeStorageVault()),
    host: createHostClient((url, init) => net.fetch(url, init)),
    local: options.local,
    async showNotRunning(state) {
      if (state.status === "starting") return showStarting(window);
      const tail = logTail(options.logFile);
      await showHostStopped(window, tail ? `${state.reason}\n\n${tail}` : state.reason);
    },
    deviceName: `${hostname()} (desktop)`,
    signIn: (clientUrl, token) => signIn(window, clientUrl, token),
    async load(clientUrl) {
      navigation.setActiveOrigin(clientUrl);
      await window.loadURL(clientUrl);
    },
    clearOrigin: (origin) => window.webContents.session.clearStorageData({ origin }),
  });
  const pages = createConnectionsPages(connections);
  const manager = createConnectionsWindow(pages, navigation, window);

  return {
    list: () => connections.list(),
    openConnections: () => manager.open(),
    localChanged: () => connections.localChanged(),
    onChange: (listener) => connections.onChange(listener),
    async connect(id) {
      try {
        await connections.connect(id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        manager.open(pages.notice("error", reason));
      }
    },
    async start() {
      const problem = await connections.start();
      if (problem !== undefined) manager.open(pages.notice("error", problem));
    },
  };
}
