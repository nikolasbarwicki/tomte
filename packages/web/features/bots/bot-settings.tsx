import {
  BrainIcon,
  CalendarDotsIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ChatsIcon,
  PencilSimpleIcon,
  ShieldCheckIcon,
  TrashIcon,
  type Icon,
} from "@phosphor-icons/react";
import { getRouteApi } from "@tanstack/react-router";
import type { BotSummary } from "@tomte/contract/events";
import { useTransition, type ReactNode } from "react";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import { confirmAction } from "@/components/confirm.tsx";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { deleteBot } from "@/host/api.ts";
import { useMemory, useRoutines } from "@/host/hooks.ts";

import type { BotSection } from "./panel-nav.ts";
import { Permissions } from "./permissions.tsx";
import { ProfileForm } from "./profile-form.tsx";

const botRoute = getRouteApi("/bots/$botId");

const TITLES: Record<BotSection, string> = {
  profile: "Profile",
  chat: "Chat & model",
  memory: "Memory",
  routines: "Routines",
  permissions: "Permissions",
};

/** "xhigh" is the only effort whose label is not its capitalised id. */
const label = (id: string) =>
  id === "xhigh" ? "X-high" : id.charAt(0).toUpperCase() + id.slice(1);

/**
 * The panel's Settings tab: an overview of what configures the bot, and the page the `section` search param names. Opening
 * a page adds a history entry, so the browser's Back returns to the overview.
 */
export function BotSettings({
  bot,
  chat,
  memory,
  routines,
}: {
  bot: BotSummary;
  /** The "Chat & model" page: double-loop switch, model and effort. */
  chat: ReactNode;
  /** The "Memory" page. */
  memory: ReactNode;
  /** The "Routines" page. */
  routines: ReactNode;
}) {
  const section = botRoute.useSearch({ select: (s) => s.section });
  const navigate = botRoute.useNavigate();
  const open = (next: BotSection | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, panel: "settings", section: next }) });
  if (section === undefined) return <Overview bot={bot} open={open} />;
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Back to settings"
          className="-ml-2"
          onClick={() => open(undefined)}
        >
          <CaretLeftIcon /> Settings
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{TITLES[section]}</h2>
      </div>
      {section === "profile" && <ProfileForm bot={bot} />}
      {section === "chat" && chat}
      {section === "memory" && memory}
      {section === "routines" && <RoutinesPage bot={bot}>{routines}</RoutinesPage>}
      {section === "permissions" && <Permissions bot={bot} />}
    </div>
  );
}

function RoutinesPage({ bot, children }: { bot: BotSummary; children: ReactNode }) {
  const list = useRoutines();
  return list?.botId === bot.id ? (
    children
  ) : (
    <div className="flex justify-center p-6">
      <Spinner className="text-muted-foreground" />
    </div>
  );
}

function Overview({ bot, open }: { bot: BotSummary; open: (section: BotSection) => void }) {
  const directions = useMemory()
    .bot.split("\n")
    .filter((l) => l.trim()).length;
  const list = useRoutines();
  const routines = list?.botId === bot.id ? list.routines.length : undefined;
  const double = bot.chatMode === "double_loop";
  const [removing, startRemoving] = useTransition();
  const remove = async () => {
    const ok = await confirmAction({
      title: `Delete ${bot.name}?`,
      description:
        "Its routines are removed, its browser logins are signed out and its open handoffs fail. Memory and files are moved to the trash folder in the data root (bots/.trash).",
      action: "Delete",
      destructive: true,
    });
    if (ok)
      startRemoving(async () => {
        await deleteBot(bot.id);
      });
  };
  return (
    <div className="grid gap-6">
      <div className="flex items-start gap-3">
        <BotAvatar avatar={bot.avatar} className="bg-muted size-16 rounded-xl p-1.5" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-medium">{bot.name}</h2>
          <p
            className={
              bot.purpose.trim() ? "text-sm break-words" : "text-muted-foreground text-sm italic"
            }
          >
            {bot.purpose.trim() || "No purpose yet"}
          </p>
        </div>
        <Button variant="outline" size="xs" onClick={() => open("profile")}>
          <PencilSimpleIcon /> Edit
        </Button>
      </div>
      <div className="grid gap-2">
        <Row
          icon={ChatsIcon}
          title="Chat & model"
          summary={
            double
              ? `Double-loop · tasks on ${label(bot.model)} · ${label(bot.effort)}`
              : `Standard · ${label(bot.model)} · ${label(bot.effort)}`
          }
          onClick={() => open("chat")}
        />
        <Row
          icon={BrainIcon}
          title="Memory"
          summary={
            directions > 0 ? `${directions} direction${directions === 1 ? "" : "s"}` : "Empty"
          }
          onClick={() => open("memory")}
        />
        <Row
          icon={CalendarDotsIcon}
          title="Routines"
          summary={
            routines === undefined
              ? "Scheduled work"
              : routines === 0
                ? "None yet"
                : `${routines} routine${routines === 1 ? "" : "s"}`
          }
          onClick={() => open("routines")}
        />
        <Row
          icon={ShieldCheckIcon}
          title="Permissions"
          summary="Tools allowed without asking"
          onClick={() => open("permissions")}
        />
      </div>
      <section className="grid gap-2" aria-labelledby="bot-danger-zone">
        <h3 id="bot-danger-zone" className="text-destructive text-sm font-medium">
          Danger zone
        </h3>
        <div className="border-destructive/30 flex items-center gap-3 rounded-lg border p-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Delete bot</p>
            <p className="text-muted-foreground text-xs">
              {bot.status === "working"
                ? "Available once the bot finishes its turn."
                : "Removes the bot and its routines."}
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            disabled={bot.status === "working" || removing}
            onClick={() => void remove()}
          >
            {removing ? <Spinner /> : <TrashIcon />} Delete bot
          </Button>
        </div>
      </section>
    </div>
  );
}

function Row({
  icon: Icon,
  title,
  summary,
  onClick,
}: {
  icon: Icon;
  title: string;
  summary: string;
  onClick: () => void;
}) {
  return (
    <Item
      variant="outline"
      size="sm"
      className="hover:bg-muted cursor-pointer text-left"
      render={<button type="button" onClick={onClick} />}
    >
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription className="line-clamp-1">{summary}</ItemDescription>
      </ItemContent>
      <CaretRightIcon className="text-muted-foreground size-4 shrink-0" />
    </Item>
  );
}
