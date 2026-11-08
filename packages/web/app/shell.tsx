import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useEffectEvent, useState } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { NewBotDialog } from "@/features/bots/index.ts";
import { needsAttention } from "@/features/integrations/index.ts";
import { useBots, useHostInfo, useIntegrations } from "@/host/hooks.ts";
import { hostStore } from "@/host/store.ts";
import { connectHostStream } from "@/host/stream.ts";

import { AppSidebar } from "./app-sidebar.tsx";

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
  const info = useHostInfo();
  const integrations = useIntegrations();
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

  return (
    <NewBotContext value={newBot}>
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar
          bots={bots ?? []}
          info={info}
          integrationsNeedingAttention={integrations.filter(needsAttention).length}
          onNewBot={newBot}
        />
        {/* Collapsed (or on a narrow window, where the sidebar is a sheet) the inset's bars start under the native window controls; expanded, the sidebar's own strip holds them. */}
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden [--titlebar-inset:env(titlebar-area-x,0px)] md:peer-data-[state=expanded]:[--titlebar-inset:0px]">
          <Outlet />
        </SidebarInset>
        <NewBotDialog open={newBotOpen} onOpenChange={setNewBotOpen} />
      </SidebarProvider>
    </NewBotContext>
  );
}
