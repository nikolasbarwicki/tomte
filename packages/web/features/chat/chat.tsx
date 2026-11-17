import { ChatTeardropDotsIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { getRouteApi } from "@tanstack/react-router";
import type { BotSummary } from "@tomte/contract/events";
import { useEffect, useEffectEvent, useState, useTransition, type ReactNode } from "react";

import { confirmAction } from "@/components/confirm.tsx";
import { AppBar } from "@/components/page.tsx";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useBots, useChat } from "@/host/hooks.ts";
import { botTheme } from "@/lib/avatars.ts";
import { cn } from "@/lib/utils";

import { newSession } from "./api.ts";
import { Composer } from "./composer.tsx";
import { ContextMeter } from "./context-meter.tsx";
import { livePresence } from "./model.ts";
import { NeedsYou } from "./needs-you.tsx";
import { RateLimitMeter } from "./rate-limit-meter.tsx";
import { Transcript } from "./transcript.tsx";

const PANEL_KEY = "tomte:panel";
const botRoute = getRouteApi("/bots/$botId");

/** One bot: its conversation, and beside it the panel with what the bot knows, made and runs. */
export function ChatView({
  bot,
  panel,
}: {
  bot: BotSummary;
  panel: (controls: { onClose: () => void }) => ReactNode;
}) {
  const chat = useChat();
  const { items, context, rateLimits } = chat;
  // A double-loop bot never has a turn that blocks the chat: its one presence line says what it is doing.
  const live = livePresence(bot.chatMode, chat);
  const busy = live !== "idle";
  const bots = useBots() ?? [];
  const wide = useMediaQuery("(min-width: 1024px)");
  const [pinned, setPinned] = useState(() => localStorage.getItem(PANEL_KEY) !== "closed");
  const [sheetOpen, setSheetOpen] = useState(false);
  const navigate = botRoute.useNavigate();
  const [starting, startNewSession] = useTransition();
  const panelOpen = wide ? pinned : sheetOpen;
  useEffect(() => localStorage.setItem(PANEL_KEY, pinned ? "open" : "closed"), [pinned]);
  const setPanelOpen = (open: boolean) => (wide ? setPinned(open) : setSheetOpen(open));
  const selectTab = (panel: "browser" | "tasks") =>
    void navigate({ search: (prev) => ({ ...prev, panel }), replace: true });
  const showTab = (panel: "browser" | "tasks") => {
    selectTab(panel);
    setPanelOpen(true);
  };

  // A takeover request needs the live view, so bring it up as soon as one arrives.
  const takeoverId = items
    .flatMap((i) =>
      i.kind === "wait" && i.waitKind === "takeover" && i.resolved === undefined ? [i.id] : [],
    )
    .at(-1);
  const [shownTakeoverId, setShownTakeoverId] = useState<string>();
  if (takeoverId !== shownTakeoverId) {
    setShownTakeoverId(takeoverId);
    if (takeoverId) setPanelOpen(true);
  }
  const onTakeover = useEffectEvent(() => selectTab("browser"));
  useEffect(() => {
    if (takeoverId) onTakeover();
  }, [takeoverId]);

  const confirmNewSession = async () => {
    const ok = await confirmAction({
      title: `Start a new session for ${bot.name}?`,
      description: "The bot forgets this conversation. Memory, files and routines are kept.",
      action: "New session",
    });
    if (ok)
      startNewSession(async () => {
        await newSession();
      });
  };

  const panelContent = panel({ onClose: () => setPanelOpen(false) });

  return (
    <div className="flex h-full min-h-0">
      <div className="bot-theme flex min-w-0 flex-1 flex-col" style={botTheme(bot.avatar.color)}>
        <AppBar>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">{bot.name}</h1>
            {bot.purpose && <p className="text-muted-foreground truncate text-xs">{bot.purpose}</p>}
          </div>
          {bot.chatMode === "double_loop" && <RateLimitMeter limits={rateLimits} />}
          <ContextMeter context={context} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="New session"
                  disabled={busy || starting}
                  onClick={() => void confirmNewSession()}
                />
              }
            >
              {starting ? <Spinner /> : <ChatTeardropDotsIcon />}
            </TooltipTrigger>
            <TooltipContent>New session</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Toggle bot panel"
                  aria-pressed={panelOpen}
                  className={cn(panelOpen && "bg-muted")}
                  onClick={() => setPanelOpen(!panelOpen)}
                />
              }
            >
              <SidebarSimpleIcon />
            </TooltipTrigger>
            <TooltipContent>Work, tasks, files, browser and settings</TooltipContent>
          </Tooltip>
        </AppBar>
        <NeedsYou bot={bot} />
        <Transcript
          bot={bot}
          bots={bots}
          items={items}
          presence={live}
          onShowBrowser={() => showTab("browser")}
          onShowTasks={() => showTab("tasks")}
        />
        <Composer bot={bot} bots={bots} />
      </div>
      {wide ? (
        panelOpen && (
          <aside className="flex w-[400px] shrink-0 flex-col border-l xl:w-[440px]">
            {panelContent}
          </aside>
        )
      ) : (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            side="right"
            showCloseButton={false}
            className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md"
          >
            <SheetTitle className="sr-only">{bot.name}</SheetTitle>
            <SheetDescription className="sr-only">
              Work, tasks, files, browser and settings
            </SheetDescription>
            {panelContent}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
