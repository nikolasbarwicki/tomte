import { app } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";

import { isPrerelease, type UpdateEngine, type UpdateEvent } from "./updates.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * electron-updater behind `UpdateEngine`. The feed is the packaged `app-update.yml` (this repository's GitHub Releases);
 * a download starts as soon as a newer release is found and installs when the app quits. Pre-releases are offered only to a
 * running pre-release, so a stable install never moves to a release candidate.
 */
export function createElectronUpdateEngine(log: (message: string) => void): UpdateEngine {
  const listeners: ((event: UpdateEvent) => void)[] = [];
  const emit = (event: UpdateEvent) => {
    for (const listener of listeners) listener(event);
  };
  /** Set by an `error` event, so a failure that arrives both as an event and as a rejection is reported once. */
  let reported = false;

  autoUpdater.logger = {
    info: (text) => log(`updater: ${String(text)}`),
    warn: (text) => log(`updater: ${String(text)}`),
    error: (text) => log(`updater: ${String(text)}`),
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = isPrerelease(app.getVersion());
  autoUpdater.on("checking-for-update", () => emit({ kind: "checking" }));
  autoUpdater.on("update-available", (info: UpdateInfo) =>
    emit({ kind: "available", version: info.version }),
  );
  autoUpdater.on("update-not-available", () => emit({ kind: "none" }));
  autoUpdater.on("update-downloaded", (info: UpdateInfo) =>
    emit({ kind: "downloaded", version: info.version }),
  );
  autoUpdater.on("error", (error: Error) => {
    reported = true;
    emit({ kind: "error", message: message(error) });
  });

  return {
    async check() {
      reported = false;
      try {
        const result = await autoUpdater.checkForUpdates();
        // A failed download is reported by the `error` event; the promise must still have a handler.
        void result?.downloadPromise?.catch(() => {});
      } catch (error) {
        if (!reported) emit({ kind: "error", message: message(error) });
      }
    },
    onEvent: (listener) => void listeners.push(listener),
    quitAndInstall() {
      reported = false;
      autoUpdater.quitAndInstall(true, true);
      if (reported) throw new Error("the install did not start");
    },
  };
}
