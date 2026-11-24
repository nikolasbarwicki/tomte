import { ListChecksIcon, XIcon } from "@phosphor-icons/react";
import type { BotSummary } from "@tomte/contract/events";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { useRoutines } from "@/host/hooks.ts";
import { PANEL_TITLES, type PanelSection } from "@/lib/bot-panel.ts";

import { Files } from "./files-section.tsx";
import { Permissions } from "./permissions.tsx";
import { ProfileSection } from "./profile-section.tsx";

/** The sections other features provide; the panel shows the one `section` names and renders no other. */
export type PanelSlots = Record<
  "work" | "tasks" | "browser" | "memory" | "routines" | "events",
  ReactNode
>;

/**
 * The bot's right-hand panel: one section at a time, a title row with a close button over a scrolling body. Which section is
 * the rail's business (or, in a narrow window, the `switcher` under the title); the panel only shows it.
 */
export function BotPanel({
  bot,
  section,
  slots,
  switcher,
  onClose,
}: {
  bot: BotSummary;
  section: PanelSection;
  slots: PanelSlots;
  /** The compact section switcher of a narrow window's sheet, where there is no rail. */
  switcher?: ReactNode;
  onClose: () => void;
}) {
  return (
    <>
      <header className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{PANEL_TITLES[section]}</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      {switcher}
      <div data-panel-section={section} className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-6">
        <Section bot={bot} section={section} slots={slots} />
      </div>
    </>
  );
}

function Section({
  bot,
  section,
  slots,
}: {
  bot: BotSummary;
  section: PanelSection;
  slots: PanelSlots;
}) {
  switch (section) {
    case "work":
    case "browser":
    case "memory":
    case "events":
      return slots[section];
    case "tasks":
      return bot.chatMode === "background_tasks" ? slots.tasks : <NeedsBackgroundTasks />;
    case "routines":
      return <Loaded bot={bot}>{slots.routines}</Loaded>;
    case "files":
      return <Files botName={bot.name} />;
    case "permissions":
      return <Permissions bot={bot} />;
    case "profile":
      return <ProfileSection bot={bot} />;
  }
}

/** Routines wait for the host to send this bot's list, so the form does not flash empty. */
function Loaded({ bot, children }: { bot: BotSummary; children: ReactNode }) {
  const list = useRoutines();
  return list?.botId === bot.id ? (
    children
  ) : (
    <div className="flex justify-center p-6">
      <Spinner className="text-muted-foreground" />
    </div>
  );
}

function NeedsBackgroundTasks() {
  return (
    <Empty className="border border-dashed p-6" data-testid="tasks-need-background-tasks">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ListChecksIcon />
        </EmptyMedia>
        <EmptyTitle className="text-sm">Tasks run in Background tasks mode</EmptyTitle>
        <EmptyDescription className="text-xs">
          In Background tasks mode the bot replies at once and runs research and work as tasks,
          which this section follows. Switch with the model chip in the message box.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
