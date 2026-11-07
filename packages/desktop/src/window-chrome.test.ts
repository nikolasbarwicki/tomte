import { describe, expect, test } from "bun:test";

import { TITLE_BAR_HEIGHT, windowChrome } from "./window-chrome.ts";

describe("windowChrome", () => {
  test("macOS hides the title strip and reserves an overlay as tall as the web UI's top bar", () => {
    expect(windowChrome("darwin")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { height: TITLE_BAR_HEIGHT },
    });
  });

  test("Windows, Linux and anything else keep the default frame", () => {
    for (const platform of ["win32", "linux", "freebsd"] as const)
      expect(windowChrome(platform)).toEqual({});
  });
});
