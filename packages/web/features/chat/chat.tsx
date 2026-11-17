import { ChatTeardropDotsIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import type { BotSummary } from "@tomte/contract/events";
import { useEffect, useEffectEvent, useTransition, type ReactNode } from "react";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import { confirmAction } from "@/components/confirm.tsx";
import { AppBar } from "@/components/page.tsx";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBots, useChat, useOpenBotId } from "@/host/hooks.ts";
import { botTheme } from "@/lib/avatars.ts";
import { cn } from "@/lib/utils";

import { newSession } from "./api.ts";
import { Composer } from "./composer.tsx";
import { ContextMeter } from "./context-meter.tsx";
import { livePresence } from "./model.ts";
import { NeedsYou } from "./needs-you.tsx";
import { RateLimitMeter } from "./rate-limit-meter.tsx";
import { Transcript } from "./transcript.tsx";
import { usePanel, type PanelControls } from "./use-panel.ts";

/** The panel's enter: it fades in while sliding 2 units from the right, and only for a visitor who has not asked for less motion. */
const PANEL_ENTER =
  "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 duration-200 ease-out";

/** One bot: its conversation, and beside it the panel with what the bot knows, made and runs, and the rail that opens it. */
export function ChatView({
  bot,
  panel,
  rail,
}: {
  bot: BotSummary;
  /** The open section's panel. In a narrow window it opens as a sheet over the chat. */
  panel: (controls: PanelControls) => ReactNode;
  /** The rail of icons on the desk's right edge; a narrow window has none, the panel brings its own switcher. */
  rail: (controls: PanelControls) => ReactNode;
}) {
  const chat = useChat();
  const { items, context, rateLimits } = chat;
  // A double-loop bot never has a turn that blocks the chat: its one presence line says what it is doing.
  const live = livePresence(bot.chatMode, chat);
  const busy = live !== "idle";
  const bots = useBots() ?? [];
  const streamed = useOpenBotId() === bot.id;
  const controls = usePanel();
  const { wide, open } = controls;
  const [starting, startNewSession] = useTransition();

  // A takeover request needs the live view, so bring it up as soon as one arrives.
  const takeoverId = items
    .flatMap((i) =>
      i.kind === "wait" && i.waitKind === "takeover" && i.resolved === undefined ? [i.id] : [],
    )
    .at(-1);
  const onTakeover = useEffectEvent(() => controls.show("browser"));
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

  // A wide window is three things on the desk: the chat and the panel are two sheets (the shell's sheet steps back for `data-split`), the rail sits bare beside them.
  return (
    <div data-split={wide || undefined} className={cn("flex h-full min-h-0", wide && "gap-2")}>
      <div
        className={cn(
          "bot-theme flex min-w-0 flex-1 flex-col",
          wide && "overflow-hidden rounded-xl bg-background shadow-(--sheet-shadow)",
        )}
        style={botTheme(bot.avatar.color)}
      >
        <AppBar>
          <h1 className="flex min-w-0 flex-1">
            <button
              type="button"
              title="Profile"
              aria-pressed={open && controls.section === "profile"}
              data-testid="profile-button"
              onClick={() => controls.pick("profile")}
              className="hover:bg-muted focus-visible:ring-ring/50 aria-pressed:bg-muted -ml-1 flex max-w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left outline-none focus-visible:ring-3"
            >
              <BotAvatar avatar={bot.avatar} className="size-5" />
              <span className="shrink-0 text-sm font-medium">{bot.name}</span>
              {bot.purpose && (
                <span className="text-muted-foreground min-w-0 truncate text-xs font-normal">
                  {bot.purpose}
                </span>
              )}
            </button>
          </h1>
          {bot.chatMode === "double_loop" && <RateLimitMeter limits={rateLimits} />}
          <ContextMeter context={context} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="New session"
                  disabled={busy || starting || !streamed}
                  onClick={() => void confirmNewSession()}
                />
              }
            >
              {starting ? <Spinner /> : <ChatTeardropDotsIcon />}
            </TooltipTrigger>
            <TooltipContent>New session</TooltipContent>
          </Tooltip>
          {!wide && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Bot panel"
                    aria-pressed={open}
                    className={cn(open && "bg-muted")}
                    onClick={controls.toggle}
                  />
                }
              >
                <SidebarSimpleIcon className="-scale-x-100" />
              </TooltipTrigger>
              <TooltipContent>Work, tasks, files, browser and more</TooltipContent>
            </Tooltip>
          )}
        </AppBar>
        <NeedsYou bot={bot} />
        <Transcript
          bot={bot}
          bots={bots}
          items={items}
          presence={live}
          onShowBrowser={() => controls.show("browser")}
          onShowTasks={() => controls.show("tasks")}
        />
        <Composer bot={bot} bots={bots} />
      </div>
      {wide ? (
        <>
          {open && (
            <aside
              className={cn(
                "bg-background flex w-[400px] shrink-0 flex-col overflow-hidden rounded-xl shadow-(--sheet-shadow) xl:w-[440px]",
                PANEL_ENTER,
              )}
            >
              {panel(controls)}
            </aside>
          )}
          {rail(controls)}
        </>
      ) : (
        <Sheet open={open} onOpenChange={(next) => !next && controls.close()}>
          <SheetContent
            side="right"
            showCloseButton={false}
            className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md"
          >
            <SheetTitle className="sr-only">{bot.name}</SheetTitle>
            <SheetDescription className="sr-only">
              Work, tasks, files, browser and more
            </SheetDescription>
            {panel(controls)}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
