import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { botMemoryPath, createBot, readMemory } from "./index.ts";

let dataRoot: string;
beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "tomte-seed-"));
});
afterEach(() => rmSync(dataRoot, { recursive: true, force: true }));

test("a memory seed is written to the new bot's own memory file", () => {
  const { id } = createBot(dataRoot, "Ada", "tests", undefined, undefined, "  Prefers tea.  ");
  expect(readMemory(botMemoryPath(dataRoot, id))).toBe("Prefers tea.\n");
});

test.each([
  ["no seed", undefined],
  ["a blank seed", "  \n "],
])("%s writes no memory file", (_label, memory) => {
  const { id } = createBot(dataRoot, "Ada", "tests", undefined, undefined, memory);
  expect(existsSync(botMemoryPath(dataRoot, id))).toBe(false);
});
