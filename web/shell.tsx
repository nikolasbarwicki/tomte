import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
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
} from "../src/contract/events.ts";
import { act, post } from "./api.ts";
import { AppSidebar } from "./app-sidebar.tsx";
import { needsAttention } from "./integrations/model.ts";
import { NewBotDialog } from "./new-bot.tsx";
import { reduce, type Item } from "./transcript.tsx";

type StreamEvent = ServerEvent | MemoryEvent | FilesEvent | RoutinesEvent | BotsEvent | IntegrationsEvent | CredentialsEvent;

/** A prompt waiting in a bot's composer, put there by an integration's Try it. */
export type Draft = { botId: string; text: string };

/** What the host has streamed to the page, plus the page-wide actions every route can take. */
export type ShellState = {
  info: HostInfo | undefined;
  /** Undefined until the host's first bots event arrives. */
  bots: BotSummary[] | undefined;
  /** The bot whose chat the host is streaming; `items`, `context`, `memory`, `files` and `routines` describe it. */
  openBotId: string | undefined;
  items: Item[];
  busy: boolean;
  context: ContextEvent | undefined;
  memory: Record<MemoryScope, string>;
  files: FilesEvent;
  routines: RoutinesEvent | undefined;
  integrations: Integration[];
  credentials: CredentialEntry[];
  draft: Draft | undefined;
  setDraft: (draft: Draft | undefined) => void;
  /** Asks the host to stream `botId`'s chat; a no-op when it already is. */
  openBot: (botId: string) => void;
  newBot: () => void;
};

const ShellContext = createContext<ShellState | undefined>(undefined);

export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell outside <Shell>");
  return shell;
}

/** The root route: owns the host event stream, the sidebar and the new-bot dialog; routes render into the inset. */
export function Shell() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<HostInfo>();
  const [bots, setBots] = useState<BotSummary[]>();
  const [openBotId, setOpenBotId] = useState<string>();
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [memory, setMemory] = useState<Record<MemoryScope, string>>({ user: "", bot: "" });
  const [context, setContext] = useState<ContextEvent>();
  const [files, setFiles] = useState<FilesEvent>({ type: "files", dir: "", files: [] });
  const [routines, setRoutines] = useState<RoutinesEvent>();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [credentials, setCredentials] = useState<CredentialEntry[]>([]);
  const [draft, setDraft] = useState<Draft>();
  const navigate = useNavigate();
  const { botId: routeBotId } = useParams({ strict: false });
  // The event handler outlives renders; it reads these instead of stale closures.
  const openBotIdRef = useRef(openBotId);
  const routeBotIdRef = useRef(routeBotId);
  routeBotIdRef.current = routeBotId;

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
        const previous = openBotIdRef.current;
        openBotIdRef.current = e.botId;
        setItems([]);
        setBusy(false);
        setContext(undefined);
        setOpenBotId(e.botId);
        // The host shows one chat at a time; when it moves away from the one on screen (another tab opened a bot), follow it.
        if (routeBotIdRef.current && routeBotIdRef.current === previous && e.botId !== previous)
          void navigate({ to: "/bots/$botId", params: { botId: e.botId }, replace: true });
        return;
      }
      if (e.type === "context") return setContext(e);
      if (e.type === "session") setContext(undefined);
      if (e.type === "user" || e.type === "update" || e.type === "routine" || (e.type === "handoff" && e.direction === "received")) setBusy(true);
      if (e.type === "done" || e.type === "error") setBusy(false);
      setItems((prev) => reduce(prev, e));
    };
    return () => es.close();
  }, [navigate]);

  const openBot = (botId: string) => {
    if (botId !== openBotIdRef.current) void act("/api/open", { botId });
  };
  const newBot = () => setNewBotOpen(true);

  return (
    <ShellContext
      value={{ info, bots, openBotId, items, busy, context, memory, files, routines, integrations, credentials, draft, setDraft, openBot, newBot }}
    >
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar bots={bots ?? []} info={info} notices={notices} integrationsNeedingAttention={integrations.filter(needsAttention).length} onNewBot={newBot} />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <Outlet />
        </SidebarInset>
        <NewBotDialog open={newBotOpen} onOpenChange={setNewBotOpen} />
      </SidebarProvider>
    </ShellContext>
  );
}
