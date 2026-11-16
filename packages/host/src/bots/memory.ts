import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { MemoryScope } from "@claudebot/contract/events";

export type MemoryPaths = Record<MemoryScope, string>;

/** Facts and preferences about the user; shared by every bot in every workspace. Lives in the data root. */
export const userMemoryPath = (dataRoot: string) => join(dataRoot, "memory.md");

/** What the user tells every bot, in every session's system prompt. Lives in the data root. */
export const instructionsPath = (dataRoot: string) => join(dataRoot, "instructions.md");

export function readMemory(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function appendMemory(path: string, line: string) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line.replace(/\n/g, " ").trim() + "\n");
}

export function writeMemory(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const body = text.trim();
  writeFileSync(path, body ? body + "\n" : "");
}
