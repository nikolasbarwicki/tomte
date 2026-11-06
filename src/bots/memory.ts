import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { MemoryScope } from "../contract/events.ts";

export type MemoryPaths = Record<MemoryScope, string>;

/** Facts and preferences about the user; shared by every bot in every workspace. */
export const userMemoryPath = () => join(process.env.CLAUDEBOT_HOME ?? join(homedir(), ".claudebot"), "memory.md");

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
