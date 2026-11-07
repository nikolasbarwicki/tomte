import { app, shell, type Session, type WebContents } from "electron";

import {
  decideNavigation,
  decidePinnedNavigation,
  decideWindowOpen,
  permissionAllowed,
} from "./navigation-policy.ts";

export interface Navigation {
  /** Makes `clientUrl`'s origin the only one windows may navigate to; every other web URL goes to the system browser. The one place the active origin is kept. */
  setActiveOrigin(clientUrl: string): void;
  /** Limits every window in `target` to the app-served page `pinned` (`scheme://host`), with no hand-off to the system browser: the Connections window's own session. */
  pinSession(target: Session, pinned: string): void;
}

function open(url: string): void {
  // A refused system-browser handoff has nothing to fall back to; the page just stays where it was.
  shell.openExternal(url).catch((error: unknown) => {
    console.error(`could not open ${new URL(url).origin} in the system browser: ${String(error)}`);
  });
}

/** Denies every permission but clipboard writes in `target`, for requests and for checks alike. */
function restrictPermissions(target: Session): void {
  target.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permissionAllowed(permission));
  });
  target.setPermissionCheckHandler((_contents, permission) => permissionAllowed(permission));
}

/** Applies the navigation policy to every web contents the app ever creates, now and later. Keeps Electron's default certificate checks: nothing here handles `certificate-error`. */
export function installNavigationPolicy(): Navigation {
  let activeOrigin: string | undefined;
  const pinned = new Map<Session, string>();

  app.on("web-contents-created", (_event, contents: WebContents) => {
    restrictPermissions(contents.session);
    const guard = (event: { preventDefault(): void }, url: string) => {
      const pin = pinned.get(contents.session);
      const decision =
        pin === undefined ? decideNavigation(url, activeOrigin) : decidePinnedNavigation(url, pin);
      if (decision.action === "allow") return;
      event.preventDefault();
      if (decision.action === "open-external") open(decision.url);
    };
    contents.on("will-navigate", (event) => guard(event, event.url));
    contents.on("will-redirect", (event) => guard(event, event.url));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      const decision =
        pinned.get(contents.session) === undefined
          ? decideWindowOpen(url, activeOrigin)
          : { action: "deny" as const };
      if (decision.action === "open-external") open(decision.url);
      return { action: "deny" };
    });
  });

  return {
    setActiveOrigin(clientUrl) {
      activeOrigin = new URL(clientUrl).origin;
    },
    pinSession(target, pin) {
      pinned.set(target, pin);
    },
  };
}
