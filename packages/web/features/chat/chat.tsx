import { useEffect, useState, useTransition, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { MessageSquarePlusIcon, PanelRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import type { BotSummary } from "@claudebot/contract/events";
import { useBots, useChat } from "@/host/hooks.ts";
import { newSession } from "./api.ts";
import { botTheme } from "@/lib/avatars.ts";
import { confirmAction } from "@/components/confirm.tsx";
import { AppBar } from "@/components/page.tsx";
import { Composer } from "./composer.tsx";
import { ContextMeter } from "./context-meter.tsx";
import { Transcript } from "./transcript.tsx";

const PANEL_KEY = "claudebot:panel";
const botRoute = getRouteApi("/bots/$botId");

/** One bot: its conversation, and beside it the panel with what the bot knows, made and runs. */
export function ChatView({ bot, panel }: { bot: BotSummary; panel: (controls: { onClose(): void }) => ReactNode }) {
  const { items, busy, context } = useChat();
  const bots = useBots() ?? [];
  const wide = useMediaQuery("(min-width: 1024px)");
  const [pinned, setPinned] = useState(() => localStorage.getItem(PANEL_KEY) !== "closed");
  const [sheetOpen, setSheetOpen] = useState(false);
  const navigate = botRoute.useNavigate();
  const [starting, startNewSession] = useTransition();
  const panelOpen = wide ? pinned : sheetOpen;
  const setPanelOpen = (open: boolean) => {
    if (!wide) return setSheetOpen(open);
    setPinned(open);
    localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
  };
  const showBrowser = () => {
    void navigate({ search: (prev) => ({ ...prev, panel: "browser" }), replace: true });
    setPanelOpen(true);
  };

  // A takeover request needs the live view, so bring it up as soon as one arrives.
  const takeoverId = items.flatMap((i) => (i.kind === "wait" && i.waitKind === "takeover" && i.resolved === undefined ? [i.id] : [])).at(-1);
  useEffect(() => {
    if (takeoverId) showBrowser();
  }, [takeoverId]);

  const panelContent = panel({ onClose: () => setPanelOpen(false) });

  return (
    <div className="flex h-full min-h-0">
      <div className="bot-theme flex min-w-0 flex-1 flex-col" style={botTheme(bot.avatar.stroke)}>
        <AppBar>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">{bot.name}</h1>
            {bot.purpose && <p className="truncate text-xs text-muted-foreground">{bot.purpose}</p>}
          </div>
          <ContextMeter context={context} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="New session"
                  disabled={busy || starting}
                  onClick={async () => {
                    const ok = await confirmAction({
                      title: `Start a new session for ${bot.name}?`,
                      description: "The bot forgets this conversation. Memory, files and routines are kept.",
                      action: "New session",
                    });
                    if (ok)
                      startNewSession(async () => {
                        await newSession();
                      });
                  }}
                />
              }
            >
              {starting ? <Spinner /> : <MessageSquarePlusIcon />}
            </TooltipTrigger>
            <TooltipContent>New session</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label="Toggle bot panel" aria-pressed={panelOpen} className={cn(panelOpen && "bg-muted")} onClick={() => setPanelOpen(!panelOpen)} />
              }
            >
              <PanelRightIcon />
            </TooltipTrigger>
            <TooltipContent>Memory, files, routines and browser</TooltipContent>
          </Tooltip>
        </AppBar>
        <Transcript bot={bot} bots={bots} items={items} busy={busy} onShowBrowser={showBrowser} />
        <Composer bot={bot} bots={bots} />
      </div>
      {wide ? (
        panelOpen && <aside className="flex w-[400px] shrink-0 flex-col border-l xl:w-[440px]">{panelContent}</aside>
      ) : (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="right" showCloseButton={false} className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
            <SheetTitle className="sr-only">{bot.name}</SheetTitle>
            <SheetDescription className="sr-only">Memory, files, routines and browser</SheetDescription>
            {panelContent}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
