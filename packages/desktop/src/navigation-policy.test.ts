import { describe, expect, test } from "bun:test";

import {
  decideNavigation,
  decidePinnedNavigation,
  decideWindowOpen,
  permissionAllowed,
} from "./navigation-policy.ts";

const ORIGIN = "http://127.0.0.1:4000";

describe("decideNavigation", () => {
  test("allows only the active origin, by scheme, host and port", () => {
    expect(decideNavigation(`${ORIGIN}/bots/1?x=1`, ORIGIN)).toEqual({ action: "allow" });
    for (const other of [
      "http://127.0.0.1:4001/",
      "http://localhost:4000/",
      "https://127.0.0.1:4000/",
      "http://127.0.0.1.evil.example/",
    ])
      expect(decideNavigation(other, ORIGIN).action).toBe("open-external");
  });

  test("hands only http and https URLs to the system browser", () => {
    expect(decideNavigation("https://example.com/a?b=c", ORIGIN)).toEqual({
      action: "open-external",
      url: "https://example.com/a?b=c",
    });
    for (const url of [
      "file:///etc/hosts",
      "javascript:alert(1)",
      "data:text/html,x",
      "mailto:a@b.c",
      "not a url",
      "",
    ])
      expect(decideNavigation(url, ORIGIN)).toEqual({ action: "deny" });
  });

  test("allows nothing while no host is loaded", () => {
    expect(decideNavigation(`${ORIGIN}/`, undefined).action).toBe("open-external");
    expect(decideNavigation("about:blank", undefined)).toEqual({ action: "deny" });
  });
});

describe("decideWindowOpen", () => {
  test("never allows a window, not even to the active origin", () => {
    expect(decideWindowOpen(`${ORIGIN}/integrations`, ORIGIN)).toEqual({ action: "deny" });
    expect(decideWindowOpen("about:blank", ORIGIN)).toEqual({ action: "deny" });
    expect(decideWindowOpen("", ORIGIN)).toEqual({ action: "deny" });
  });

  test("sends other web URLs to the system browser", () => {
    expect(decideWindowOpen("https://provider.example/authorize?code_challenge=x", ORIGIN)).toEqual(
      {
        action: "open-external",
        url: "https://provider.example/authorize?code_challenge=x",
      },
    );
  });
});

describe("permissionAllowed", () => {
  test("allows clipboard writes and nothing else", () => {
    expect(permissionAllowed("clipboard-sanitized-write")).toBe(true);
    for (const p of ["clipboard-read", "geolocation", "notifications", "media", "openExternal", ""])
      expect(permissionAllowed(p)).toBe(false);
  });
});

describe("decidePinnedNavigation", () => {
  const PINNED = "claudebot-desktop://connections";

  test("allows only the pinned scheme and host, and never hands anything to the system browser", () => {
    expect(decidePinnedNavigation(`${PINNED}/add`, PINNED)).toEqual({ action: "allow" });
    expect(decidePinnedNavigation(`${PINNED}/?m=1`, PINNED)).toEqual({ action: "allow" });
    for (const url of [
      "claudebot-desktop://other/",
      "https://example.com/",
      "http://127.0.0.1:4000/",
      "file:///etc/hosts",
      "nope",
    ])
      expect(decidePinnedNavigation(url, PINNED)).toEqual({ action: "deny" });
  });
});
