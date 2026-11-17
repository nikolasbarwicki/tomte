import { expect, test } from "bun:test";

import { upgradePanel } from "./bot-panel.ts";

test.each([
  ["settings", "routines", "routines"],
  ["settings", "permissions", "permissions"],
  ["settings", "profile", "profile"],
  ["settings", undefined, "profile"],
  ["work", undefined, "work"],
  ["browser", "memory", "browser"],
  [undefined, undefined, undefined],
] as const)("a link with panel=%s and section=%s opens %s", (panel, section, opened) => {
  expect(upgradePanel(panel, section)).toBe(opened);
});
