import {
  AlarmIcon,
  BrainIcon,
  BriefcaseIcon,
  FolderIcon,
  GlobeIcon,
  ListChecksIcon,
  ShieldCheckIcon,
  WebhooksLogoIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { BotSummary } from "@tomte/contract/events";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PANEL_TITLES, RAIL_GROUPS, type PanelSection, type RailSection } from "@/lib/bot-panel.ts";
import { cn } from "@/lib/utils";

import { RailHint, type TaskCounts } from "./rail-hints.tsx";

const ICONS: Record<RailSection, Icon> = {
  work: BriefcaseIcon,
  tasks: ListChecksIcon,
  browser: GlobeIcon,
  files: FolderIcon,
  memory: BrainIcon,
  routines: AlarmIcon,
  permissions: ShieldCheckIcon,
  events: WebhooksLogoIcon,
};

/**
 * The bot panel's sections as icons: a column on the desk beside the panel (wide windows), or a row under the title of the sheet
 * (narrow ones). The order never changes, whatever the bot does; what does change is the marks (Work's count of what needs you,
 * a live dot on Tasks and Browser) and the one-line summary each icon's tooltip shows.
 */
export function ActivityRail({
  bot,
  active,
  onPick,
  tasks,
  orientation = "vertical",
}: {
  bot: BotSummary;
  /** The section on screen; none while the panel is closed. */
  active: PanelSection | undefined;
  onPick: (section: RailSection) => void;
  tasks: TaskCounts;
  orientation?: "vertical" | "horizontal";
}) {
  const vertical = orientation === "vertical";
  return (
    <nav
      aria-label={`${bot.name} panel`}
      data-testid="panel-rail"
      className={cn(
        vertical
          ? "flex w-10 shrink-0 flex-col items-center gap-1 pt-0.5 pb-0.5 [--mark-ring:var(--sidebar)]"
          : "flex items-center justify-between gap-1 px-3 pb-2 [--mark-ring:var(--background)]",
      )}
    >
      {RAIL_GROUPS.map((group, i) => (
        <div
          key={i}
          className={cn(
            vertical ? "grid gap-1" : "flex gap-1",
            i > 0 && (vertical ? "border-sidebar-border mt-1 border-t pt-2" : "border-l pl-1"),
            vertical && i === RAIL_GROUPS.length - 1 && "mt-auto",
          )}
        >
          {group.map((section) => (
            <RailButton
              key={section}
              section={section}
              bot={bot}
              tasks={tasks}
              active={active === section}
              vertical={vertical}
              onPick={onPick}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

function RailButton({
  section,
  bot,
  tasks,
  active,
  vertical,
  onPick,
}: {
  section: RailSection;
  bot: BotSummary;
  tasks: TaskCounts;
  active: boolean;
  vertical: boolean;
  onPick: (section: RailSection) => void;
}) {
  const I = ICONS[section];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={PANEL_TITLES[section]}
            aria-pressed={active}
            data-section={section}
            onClick={() => onPick(section)}
            className={cn(
              "text-muted-foreground focus-visible:ring-ring/50 relative grid size-9 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-3",
              active
                ? vertical
                  ? "bg-background text-foreground shadow-(--sheet-shadow)"
                  : "bg-muted text-foreground"
                : "hover:bg-sidebar-accent hover:text-foreground",
            )}
          />
        }
      >
        <I className="size-[18px]" weight={active ? "fill" : "regular"} />
        <Mark section={section} bot={bot} running={tasks.running > 0} />
      </TooltipTrigger>
      <TooltipContent side={vertical ? "left" : "bottom"} className="grid max-w-56 gap-0.5">
        <span className="font-medium">{PANEL_TITLES[section]}</span>
        <span className="opacity-70">
          <RailHint section={section} bot={bot} tasks={tasks} />
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Work: how many things need you. Tasks: one runs. Browser: it is on. */
function Mark({
  section,
  bot,
  running,
}: {
  section: RailSection;
  bot: BotSummary;
  running: boolean;
}): ReactNode {
  if (section === "work" && bot.needsYou > 0)
    return (
      <span
        className="absolute -top-1 -right-1 min-w-4 rounded-full bg-amber-200 px-1 text-[10px] leading-4 font-semibold text-amber-800 tabular-nums ring-2 ring-(--mark-ring) dark:bg-amber-900 dark:text-amber-300"
        aria-label={`${bot.needsYou} need you`}
        data-needs-you={bot.needsYou}
      >
        {bot.needsYou}
      </span>
    );
  if (section === "tasks" && running) return <LiveDot label="running" />;
  if (section === "browser" && bot.browser.enabled) return <LiveDot label="on" />;
  return null;
}

function LiveDot({ label }: { label: string }) {
  return (
    <span
      className="absolute top-0.5 right-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-(--mark-ring)"
      role="img"
      aria-label={label}
    />
  );
}
