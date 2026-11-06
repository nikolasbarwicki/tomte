import { createContext, useCallback, useContext, useEffect, useEffectEvent, useState } from "react";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar.tsx";
import { useBots, useHostInfo, useIntegrations, useNotices } from "@/host/hooks.ts";
import { connectHostStream } from "@/host/stream.ts";
import { hostStore } from "@/host/store.ts";
import { needsAttention } from "@/features/integrations/index.ts";
import { NewBotDialog } from "@/features/bots/index.ts";

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
  const notices = useNotices();
  const integrations = useIntegrations();
  const navigate = useNavigate();
  const { botId: routeBotId } = useParams({ strict: false });

  // The host shows one chat at a time; when it moves away from the one on screen (another tab opened a bot), follow it.
  const followReset = useEffectEvent((previous: string | undefined, next: string) => {
    if (routeBotId && routeBotId === previous && next !== previous) void navigate({ to: "/bots/$botId", params: { botId: next }, replace: true });
  });
  useEffect(() => connectHostStream(hostStore, { onReset: (previous, next) => followReset(previous, next) }), []);

  return (
    <NewBotContext value={newBot}>
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar bots={bots ?? []} info={info} notices={notices} integrationsNeedingAttention={integrations.filter(needsAttention).length} onNewBot={newBot} />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <Outlet />
        </SidebarInset>
        <NewBotDialog open={newBotOpen} onOpenChange={setNewBotOpen} />
      </SidebarProvider>
    </NewBotContext>
  );
}
