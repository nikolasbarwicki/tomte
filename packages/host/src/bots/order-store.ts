import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

const BotOrder = z.array(z.string());

const orderPath = (dataRoot: string) => join(dataRoot, "bot-order.json");

/** The ids the owner has placed by dragging in the sidebar, top first; empty when none was, or when the file cannot be read. */
export function readBotOrder(dataRoot: string): string[] {
  const file = orderPath(dataRoot);
  if (!existsSync(file)) return [];
  try {
    return BotOrder.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

/** Saves the owner's order, written whole through a rename so a reader never sees half of it. Repeated ids are dropped. */
export function writeBotOrder(dataRoot: string, ids: string[]) {
  const partial = `${orderPath(dataRoot)}.partial`;
  writeFileSync(partial, JSON.stringify([...new Set(ids)]) + "\n");
  renameSync(partial, orderPath(dataRoot));
}
