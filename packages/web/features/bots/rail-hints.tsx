import type { BotSummary } from "@tomte/contract/events";
import { useEffect, useState } from "react";

import { useFiles, useMemory, useRoutines, useWork } from "@/host/hooks.ts";
import type { RailSection } from "@/lib/bot-panel.ts";
import { duration } from "@/lib/format.ts";

import { fetchAllowances } from "./api.ts";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Non-blank lines of a memory file: one direction or fact each. */
const lines = (text: string) => text.split("\n").filter((l) => l.trim()).length;

/** What the bot's background tasks are doing, as the Tasks section counts them. */
export interface TaskCounts {
  running: number;
  queued: number;
}

/**
 * The one-line live summary under a rail icon's name. Each is a component of its own, mounted only while the tooltip is open,
 * so a closed tooltip subscribes to nothing and an open one is current when it opens.
 */
export function RailHint({
  section,
  bot,
  tasks,
}: {
  section: RailSection;
  bot: BotSummary;
  tasks: TaskCounts;
}) {
  switch (section) {
    case "work":
      return <WorkHint bot={bot} />;
    case "tasks":
      if (bot.chatMode !== "background_tasks") return "Needs Background tasks mode";
      return tasks.running + tasks.queued === 0
        ? "Idle"
        : `${tasks.running} running${tasks.queued ? `, ${tasks.queued} queued` : ""}`;
    case "browser":
      return bot.browser.enabled ? "On" : "Off";
    case "files":
      return <FilesHint />;
    case "memory":
      return <MemoryHint />;
    case "routines":
      return <RoutinesHint botId={bot.id} />;
    case "permissions":
      return <PermissionsHint botId={bot.id} />;
    case "events":
      return "Where scripts and agents post events";
  }
}

function WorkHint({ bot }: { bot: BotSummary }) {
  const work = useWork();
  if (bot.needsYou > 0)
    return `${plural(bot.needsYou, "thing")} need${bot.needsYou === 1 ? "s" : ""} you`;
  if (work?.botId !== bot.id) return "Sources reporting to this bot";
  return work.sources.length === 0
    ? "No sources yet"
    : `${plural(work.sources.length, "source")}, all quiet`;
}

function FilesHint() {
  const { files } = useFiles();
  return files.length === 0 ? "No files yet" : plural(files.length, "file");
}

function MemoryHint() {
  const directions = lines(useMemory("bot"));
  const facts = lines(useMemory("user"));
  return directions + facts === 0
    ? "Empty"
    : `${plural(directions, "direction")} · ${facts} about you`;
}

function RoutinesHint({ botId }: { botId: string }) {
  const list = useRoutines();
  const [now] = useState(Date.now);
  if (list?.botId !== botId) return "Scheduled work";
  const next = list.routines
    .filter((r) => r.active && r.nextRunAt !== null)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];
  if (!next?.nextRunAt) return list.routines.length === 0 ? "None yet" : "None scheduled";
  const wait = next.nextRunAt - now;
  return `Next: ${next.name}, ${wait <= 0 ? "due now" : `in ${duration(wait)}`}`;
}

function PermissionsHint({ botId }: { botId: string }) {
  const [count, setCount] = useState<number>();
  useEffect(() => {
    let current = true;
    void fetchAllowances(botId).then((r) => {
      if (current && !("error" in r)) setCount(r.allowances.length);
    });
    return () => {
      current = false;
    };
  }, [botId]);
  if (count === undefined) return "Tools allowed without asking";
  return count === 0
    ? "Nothing allowed without asking"
    : `${plural(count, "tool")} allowed without asking`;
}
