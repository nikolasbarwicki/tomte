import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { toast } from "sonner";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  BotsEvent,
  BotSummary,
  ContextEvent,
  CredentialEntry,
  CredentialsEvent,
  FilesEvent,
  HostInfo,
  Integration,
  IntegrationsEvent,
  MemoryEvent,
  MemoryScope,
  Notice,
  RoutinesEvent,
  ServerEvent,
} from "./events.ts";
import { act, post } from "./api.ts";
import { AppSidebar, type View } from "./app-sidebar.tsx";
import { ChatView } from "./chat.tsx";
import { ConfirmHost } from "./confirm.tsx";
import { Credentials } from "./credentials.tsx";
import { Integrations } from "./integrations.tsx";
import { NewBotDialog } from "./new-bot.tsx";
import { reduce, type Item } from "./transcript.tsx";
import { Welcome } from "./welcome.tsx";

type StreamEvent = ServerEvent | MemoryEvent | FilesEvent | RoutinesEvent | BotsEvent | IntegrationsEvent | CredentialsEvent;

function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<HostInfo>();
  const [bots, setBots] = useState<BotSummary[]>();
  const [botId, setBotId] = useState<string>();
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [memory, setMemory] = useState<Record<MemoryScope, string>>({ user: "", bot: "" });
  const [context, setContext] = useState<ContextEvent>();
  const [files, setFiles] = useState<FilesEvent>({ type: "files", dir: "", files: [] });
  const [routines, setRoutines] = useState<RoutinesEvent>();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [credentials, setCredentials] = useState<CredentialEntry[]>([]);
  const [view, setView] = useState<View>("chat");
  const bot = bots?.find((b) => b.id === botId);

  useEffect(() => {
    post("/api/info", {}).then(async (r) => setInfo(await r.json()));
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as StreamEvent;
      if (e.type === "integrations") return setIntegrations(e.integrations);
      if (e.type === "credentials") return setCredentials(e.credentials);
      if (e.type === "memory") return setMemory((prev) => ({ ...prev, [e.scope]: e.text }));
      if (e.type === "files") return setFiles(e);
      if (e.type === "routines") return setRoutines(e);
      if (e.type === "bots") return setBots(e.bots);
      if (e.type === "notify") {
        setNotices((prev) => [e, ...prev].slice(0, 50));
        if (Date.now() - e.at < 5_000) toast(e.title, { description: e.body || undefined });
        return;
      }
      if (e.type === "reset") {
        setItems([]);
        setBusy(false);
        setContext(undefined);
        setBotId(e.botId);
        return;
      }
      if (e.type === "context") return setContext(e);
      if (e.type === "session") setContext(undefined);
      if (e.type === "user" || e.type === "update" || e.type === "routine" || (e.type === "handoff" && e.direction === "received")) setBusy(true);
      if (e.type === "done" || e.type === "error") setBusy(false);
      setItems((prev) => reduce(prev, e));
    };
    return () => es.close();
  }, []);

  // A finished turn counts as seen once the open bot's chat is actually on screen.
  useEffect(() => {
    if (!botId || bot?.status !== "unseen" || view !== "chat") return;
    const markSeen = () => document.visibilityState === "visible" && post("/api/seen", { botId });
    markSeen();
    document.addEventListener("visibilitychange", markSeen);
    return () => document.removeEventListener("visibilitychange", markSeen);
  }, [botId, bot?.status, view]);

  const openBot = (id: string) => {
    setView("chat");
    if (id !== botId) void act("/api/open", { botId: id });
  };

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar
        bots={bots ?? []}
        botId={botId}
        view={view}
        info={info}
        notices={notices}
        integrationsNeedingAttention={integrations.filter((i) => i.enabled && (i.state === "failed" || i.state === "needs-auth")).length}
        onView={setView}
        onOpenBot={openBot}
        onNewBot={() => setNewBotOpen(true)}
      />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        {view === "integrations" ? (
          <Integrations integrations={integrations} />
        ) : view === "credentials" ? (
          <Credentials credentials={credentials} bots={bots ?? []} />
        ) : bot ? (
          <ChatView
            key={bot.id}
            bot={bot}
            bots={bots ?? []}
            items={items}
            busy={busy}
            context={context}
            memory={memory}
            files={files}
            routines={routines?.botId === bot.id ? routines.routines : undefined}
            browserUnavailable={info?.browser.status === "unavailable" ? info.browser.reason : undefined}
          />
        ) : (
          <Welcome loading={!bots} hasBots={!!bots?.length} onNewBot={() => setNewBotOpen(true)} />
        )}
      </SidebarInset>
      <NewBotDialog open={newBotOpen} onOpenChange={setNewBotOpen} />
    </SidebarProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <TooltipProvider>
      <App />
      <ConfirmHost />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  </ThemeProvider>,
);
