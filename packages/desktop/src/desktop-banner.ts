import { Notification, net, type BrowserWindow } from "electron";

import type { Background } from "./background.ts";
import { followBots, type BotsFollower } from "./bots-stream.ts";
import type { DesktopConnections } from "./desktop-connections.ts";
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
 * Follows the active connection's event stream with the credentials the app already holds for it (the launch token's
 * device for this computer, the profile's device token for a remote) and raises the needs-you banner while the window
 * is hidden. The followed host changes with the connection and with the local host's restarts.
 */
export function setupBanner(options: {
  window: BrowserWindow;
  background: Background;
  connections: Pick<DesktopConnections, "credentials" | "onChange">;
  log: (message: string) => void;
}): { notifier: Notifier } {
  const { window, background, connections, log } = options;
  let followed: { key: string; origin: string; follower: BotsFollower } | undefined;
  const notifier: Notifier = { show: showNotification };
  const banner = createNeedsYouBanner({
    visible: () => background.visible(),
    show: (note) => notifier.show(note),
    reveal: () => background.reveal(),
    openBot(botId) {
      if (followed === undefined) return;
      const url = new URL(`/bots/${encodeURIComponent(botId)}`, followed.origin).href;
      window
        .loadURL(url)
        .catch((error: unknown) => log(`could not open the bot: ${String(error)}`));
    },
  });
  window.on("show", banner.windowShown);

  /** The newest call wins: reading a profile's token is asynchronous. */
  let calls = 0;
  async function follow(): Promise<void> {
    const mine = ++calls;
    const credentials = await connections.credentials().catch(() => undefined);
    if (mine !== calls) return;
    const key = credentials && `${credentials.origin}\n${credentials.token}`;
    if (key === followed?.key) return;
    followed?.follower.stop();
    followed = undefined;
    banner.reset();
    if (credentials === undefined || key === undefined) return;
    const { origin } = credentials;
    followed = {
      key,
      origin,
      follower: followBots(credentials, {
        fetch: (url, init) => net.fetch(url, init),
        onOpen: banner.reset,
        onBots: banner.update,
        onDown: (reason) => log(`event stream of ${origin} is down: ${reason}`),
      }),
    };
  }
  connections.onChange(() => void follow());
  return { notifier };
}
