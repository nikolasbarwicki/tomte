/** What the app does with a URL a page wants to navigate or open a window to. Pure, so the policy is readable without Electron. */
export type NavigationDecision =
  /** The URL belongs to the active origin: let the navigation proceed. */
  | { action: "allow" }
  /** Refuse it, and hand it to the system browser. */
  | { action: "open-external"; url: string }
  /** Refuse it and do nothing else. */
  | { action: "deny" };

/** `url` is what the page asked for; `activeOrigin` is the origin of the host the window shows, or undefined while none is loaded. */
export function decideNavigation(
  url: string,
  activeOrigin: string | undefined,
): NavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { action: "deny" };
  }
  if (activeOrigin !== undefined && parsed.origin === activeOrigin) return { action: "allow" };
  if (parsed.protocol === "http:" || parsed.protocol === "https:")
    return { action: "open-external", url: parsed.href };
  return { action: "deny" };
}

/** A window never opens: a target inside the active origin is denied like the rest, only other web URLs reach the system browser. */
export function decideWindowOpen(
  url: string,
  activeOrigin: string | undefined,
): NavigationDecision {
  const decision = decideNavigation(url, activeOrigin);
  return decision.action === "allow" ? { action: "deny" } : decision;
}

/** The only permission a page gets: writing to the clipboard, which the UI's copy buttons need. */
export function permissionAllowed(permission: string): boolean {
  return permission === "clipboard-sanitized-write";
}

/** A window pinned to one app-served page (the Connections window): `scheme//host` of `pinned`, such as `tomte-desktop://connections`, is allowed and everything else is denied, with no hand-off to the system browser. Compared as protocol and host because Node gives a custom scheme an opaque origin. */
export function decidePinnedNavigation(url: string, pinned: string): NavigationDecision {
  try {
    const parsed = new URL(url);
    if (`${parsed.protocol}//${parsed.host}` === pinned) return { action: "allow" };
  } catch {
    // Not a URL: denied below.
  }
  return { action: "deny" };
}
