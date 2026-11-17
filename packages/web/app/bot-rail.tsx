import type { BotSummary } from "@tomte/contract/events";
import { useMemo } from "react";

import { ActivityRail } from "@/features/bots/index.ts";
import type { PanelControls } from "@/features/chat/index.ts";
import { groupTasks } from "@/features/tasks/index.ts";
import { useChat } from "@/host/hooks.ts";

/** The activity rail wired to the open panel and to the open chat's tasks; narrow windows use it as the sheet's switcher. */
export function BotRail({
  bot,
  controls,
  orientation,
}: {
  bot: BotSummary;
  controls: PanelControls;
  orientation?: "vertical" | "horizontal";
}) {
  const { items } = useChat();
  const { running, queued } = useMemo(() => groupTasks(items), [items]);
  const counts = useMemo(
    () => ({ running: running.length, queued: queued.length }),
    [running, queued],
  );
  return (
    <ActivityRail
      bot={bot}
      active={controls.open ? controls.section : undefined}
      onPick={controls.pick}
      tasks={counts}
      {...(orientation && { orientation })}
    />
  );
}
