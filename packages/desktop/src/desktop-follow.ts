import { Notification, net, type BrowserWindow } from "electron";

import type { Background } from "./background.ts";
import type { DesktopConnections } from "./desktop-connections.ts";
import { createFollowedHosts, type HostView } from "./follow-hosts.ts";
import { followHost } from "./host-stream.ts";
import { createNeedsYouBanner, type Note } from "./needs-you-banner.ts";

/** Where the banner hands a note to the OS. A smoke of the packaged app replaces `show` (through `desktop.banner` in `main.ts`) to record notes without raising a real OS banner or asking for the OS notification permission. */
export interface Notifier {
  show: (note: Note) => { close: () => void };
}

/** Electron's own notification: an OS banner that only the main process can raise, so no web page ever asks for the permission. A platform without notifications raises none. */
function showNotification(note: Note): { close: () => void } {
  if (!Notification.isSupported()) return { close: () => {} };
  const notification = new Notification({ title: note.title, body: note.body });
  notification.on("click", note.onClick);
  notification.show();
  return { close: () => notification.close() };
}

/**
 * Follows the event stream of this computer's host while it runs and of every paired server, each with the credentials
 * the app already holds for it (the launch token's device for this computer, the profile's device token for a remote),
 * whichever host the window shows. Raises the needs-you banner while the window is hidden and keeps what the tray needs
 * to say about each host. The followed set changes with the profiles and with the local host's restarts.
 */
export function setupFollow(options: {
  window: BrowserWindow;
  background: Background;
  connections: Pick<DesktopConnections, "followTargets" | "onChange" | "connect">;
  log: (message: string) => void;
}): {
  notifier: Notifier;
  view: (id: string) => HostView | undefined;
  /** Calls `listener` after every change to what is known of a followed host. */
  onChange: (listener: () => void) => void;
} {
  const { window, background, connections, log } = options;
  const notifier: Notifier = { show: showNotification };
  const listeners: (() => void)[] = [];
  const banner = createNeedsYouBanner({
    visible: () => background.visible(),
    show: (note) => notifier.show(note),
    reveal: () => background.reveal(),
    open(hostId, botId) {
      void connections.connect(
        hostId,
        botId === undefined ? undefined : `/bots/${encodeURIComponent(botId)}`,
      );
    },
  });
  window.on("show", banner.windowShown);
  const hosts = createFollowedHosts({
    start: (target, on) =>
      followHost(target, { fetch: (url, init) => net.fetch(url, init), ...on }),
    banner,
    changed: () => listeners.forEach((listener) => listener()),
    log,
  });

  /** The newest call wins: reading a profile's token is asynchronous. */
  let calls = 0;
  async function follow(): Promise<void> {
    const mine = ++calls;
    const targets = await connections.followTargets().catch(() => undefined);
    if (mine === calls && targets !== undefined) hosts.sync(targets);
  }
  connections.onChange(() => void follow());
  return { notifier, view: hosts.view, onChange: (listener) => void listeners.push(listener) };
}
