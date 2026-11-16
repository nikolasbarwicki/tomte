import type { Database } from "bun:sqlite";

import type { BotStatus, BotsEvent, FilesEvent, MemoryEvent } from "@claudebot/contract/events";

import {
  BROWSER_FILES_DIR,
  botFilesPath,
  botMemoryPath,
  getActivity,
  listBots,
  listFiles,
  readMemory,
  userMemoryPath,
} from "../bots/index.ts";
import type { OpenItems } from "../events/index.ts";
import type { Wait, WaitKind } from "../waits/index.ts";

/** What the sidebar needs to know about human waits to count them. */
export interface WaitCounts {
  /** Every bot's open waits, oldest first. */
  list(): Wait[];
  /** The name of the routine a run belongs to; undefined for a run that is gone. */
  routineName(runId: string): string | undefined;
  /** Whether an external event is still an open needs-you item. */
  eventOpen(botId: string, eventId: string): boolean;
}

const KIND_LABEL: Record<WaitKind, string> = {
  tool_approval: "Approval",
  question: "Question",
  takeover: "Takeover",
  credential: "Approval",
};

/**
 * A bot's open external items plus its open human waits. A question about an external event is that event's item already and is
 * not counted again while the event is open. A source is named once; a wait newer than every external item is named first.
 */
function withWaits(
  botId: string,
  items: OpenItems | undefined,
  open: Wait[],
  waits: WaitCounts,
): OpenItems | undefined {
  const own = open.filter(
    (w) =>
      w.botId === botId &&
      !(w.kind === "question" && w.payload.eventId && waits.eventOpen(botId, w.payload.eventId)),
  );
  if (!own.length) return items;
  const external = items ?? { count: 0, sources: [], newestAt: 0 };
  const newestWait = own[own.length - 1]!.createdAt;
  const labels = own
    .map((w) => (w.runId !== null ? waits.routineName(w.runId) : undefined) ?? KIND_LABEL[w.kind])
    .reverse();
  const sources = [
    ...new Set(
      newestWait > external.newestAt
        ? [...labels, ...external.sources]
        : [...external.sources, ...labels],
    ),
  ];
  return {
    count: external.count + own.length,
    sources,
    newestAt: Math.max(external.newestAt, newestWait),
  };
}

/** The sidebar: every bot with its latest message, whether it is working, unseen or idle, and its open needs-you items and waits. */
export const botsEvent = (
  dataRoot: string,
  db: Database,
  isWorking: (botId: string) => boolean,
  needsYou: () => ReadonlyMap<string, OpenItems>,
  waits: WaitCounts,
): BotsEvent => {
  const listed = listBots(dataRoot);
  // No bots, no count query: a host with nothing to list has nothing to ask the database.
  const open = listed.length > 0 ? needsYou() : new Map<string, OpenItems>();
  const openWaits = listed.length > 0 ? waits.list() : [];
  return {
    type: "bots",
    bots: listed.map((bot) => {
      const activity = getActivity(db, bot.id);
      const last = activity?.last ?? null;
      const status: BotStatus = isWorking(bot.id)
        ? "working"
        : last?.from === "bot" && last.at > (activity?.seenAt ?? 0)
          ? "unseen"
          : "idle";
      const items = withWaits(bot.id, open.get(bot.id), openWaits, waits);
      return {
        ...bot,
        last,
        status,
        needsYou: items?.count ?? 0,
        needsYouSources: items?.sources ?? [],
        needsYouAt: items?.newestAt ?? 0,
      };
    }),
  };
};

/** User memory, and the open bot's memory (empty when no bot is open). */
export const memoryEvents = (dataRoot: string, botId: string | undefined): MemoryEvent[] => [
  { type: "memory", scope: "user", text: readMemory(userMemoryPath(dataRoot)) },
  { type: "memory", scope: "bot", text: botId ? readMemory(botMemoryPath(dataRoot, botId)) : "" },
];

/** The open bot's files, without the browser's own folder. */
export const filesEvent = (dataRoot: string, botId: string | undefined): FilesEvent => {
  const dir = botId ? botFilesPath(dataRoot, botId) : "";
  return {
    type: "files",
    dir,
    files: dir ? listFiles(dir).filter((f) => !f.path.startsWith(`${BROWSER_FILES_DIR}/`)) : [],
  };
};
