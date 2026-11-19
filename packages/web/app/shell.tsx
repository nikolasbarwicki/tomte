import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { needsYou } from "@tomte/contract/host-status";
import { createContext, useCallback, useContext, useEffect, useEffectEvent, useState } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { NewBotDialog } from "@/features/bots/index.ts";
import { needsAttention } from "@/features/integrations/index.ts";
import { useBots, useHostStatus, useIntegrations } from "@/host/hooks.ts";
import { hostStore } from "@/host/store.ts";
import { connectHostStream } from "@/host/stream.ts";

import { AppSidebar } from "./app-sidebar.tsx";
import { HostProblems } from "./host-problems.tsx";

const NewBotContext = createContext<(() => void) | undefined>(undefined);

/** Opens the new-bot dialog. The function never changes identity, so reading it does not re-render. */
export function useNewBot(): () => void {
  const newBot = useContext(NewBotContext);
  if (!newBot) throw new Error("useNewBot outside <Shell>");
  return newBot;
}

/** The root route: owns the host event stream, the sidebar and the new-bot dialog; routes render into the inset. */
export function Shell() {
  const [newBotOpen, setNewBotOpen] = useState(false);
  const newBot = useCallback(() => setNewBotOpen(true), []);
  const bots = useBots();
  const integrations = useIntegrations();
  const status = useHostStatus();
  const navigate = useNavigate();
  const { botId: routeBotId } = useParams({ strict: false });

  // The host shows one chat at a time; when it moves away from the one on screen (another tab opened a bot), follow it.
  const followReset = useEffectEvent((previous: string | undefined, next: string) => {
    if (routeBotId && routeBotId === previous && next !== previous)
      void navigate({ to: "/bots/$botId", params: { botId: next }, replace: true });
  });
  useEffect(
    () =>
      connectHostStream(hostStore, { onReset: (previous, next) => followReset(previous, next) }),
    [],
  );

  // The tab's badge counts what waits for the user on this host: its bots' items and its problems.
  const waiting = needsYou(bots ?? [], status);
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) Bots` : "Bots";
  }, [waiting]);

  return (
    <NewBotContext value={newBot}>
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar
          bots={bots ?? []}
          integrationsNeedingAttention={integrations.filter(needsAttention).length}
          onNewBot={newBot}
        />
        {/* On a narrow window, where the sidebar is a sheet, the inset's bars start under the native window controls; from md up the sidebar is always there (its narrowest stop is a rail as wide as the controls) and its own strip holds them. From md up the inset is the sheet on the desk (the sidebar's `variant="inset"`): 8px from the window's edges, with its own corners and shadow. A view that lays out sheets of its own (`data-split`, the chat beside its panel and the rail) gets a bare inset instead. */}
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden [--titlebar-inset:env(titlebar-area-x,0px)] has-data-split:overflow-visible has-data-split:bg-transparent md:[--titlebar-inset:0px] md:peer-data-[variant=inset]:shadow-(--sheet-shadow) md:peer-data-[variant=inset]:has-data-split:shadow-none">
          <HostProblems problems={status?.problems ?? []} />
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </SidebarInset>
        {/* The desk's margin above the sheet and the sidebar moves the window too. */}
        <div
          data-titlebar
          aria-hidden
          className="fixed inset-x-0 top-0 z-20 hidden h-2 [:root[data-wco]_&]:block"
        />
        <NewBotDialog open={newBotOpen} onOpenChange={setNewBotOpen} />
      </SidebarProvider>
    </NewBotContext>
  );
}
