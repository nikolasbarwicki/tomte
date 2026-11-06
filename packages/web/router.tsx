import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect } from "react";

import { post } from "./api.ts";
import { ChatView } from "./chat.tsx";
import { Credentials } from "./credentials.tsx";
import { Integrations } from "./integrations/screen.tsx";
import { Shell, useShell } from "./shell.tsx";
import { Welcome } from "./welcome.tsx";

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: () => <Navigate to="/" replace />,
});

/** Lands on the chat the host is showing, or welcomes the user when there is none. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: function Home() {
    const { bots, openBotId, newBot } = useShell();
    if (openBotId && bots?.some((b) => b.id === openBotId))
      return <Navigate to="/bots/$botId" params={{ botId: openBotId }} replace />;
    return <Welcome loading={!bots} hasBots={!!bots?.length} onNewBot={newBot} />;
  },
});

const botRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bots/$botId",
  component: function BotChat() {
    const { botId } = botRoute.useParams();
    const s = useShell();
    const bot = s.bots?.find((b) => b.id === botId);
    const shown = !!bot && s.openBotId === botId;

    // Deliberately not keyed on `openBotId`: when the host moves to another bot, the shell follows it rather than pulling it back.
    useEffect(() => {
      if (bot) s.openBot(botId);
    }, [botId, !!bot]);

    // A finished turn counts as seen once this chat is actually on screen.
    useEffect(() => {
      if (!shown || bot.status !== "unseen") return;
      const markSeen = () => document.visibilityState === "visible" && post("/api/seen", { botId });
      markSeen();
      document.addEventListener("visibilitychange", markSeen);
      return () => document.removeEventListener("visibilitychange", markSeen);
    }, [botId, shown, bot?.status]);

    if (s.bots && !bot) return <Navigate to="/" replace />;
    if (!shown) return <Welcome loading hasBots onNewBot={s.newBot} />;
    return (
      <ChatView
        key={bot.id}
        bot={bot}
        bots={s.bots ?? []}
        items={s.items}
        busy={s.busy}
        context={s.context}
        memory={s.memory}
        files={s.files}
        routines={s.routines?.botId === bot.id ? s.routines.routines : undefined}
        browserUnavailable={
          s.info?.browser.status === "unavailable" ? s.info.browser.reason : undefined
        }
        draft={s.draft?.botId === bot.id ? s.draft.text : undefined}
        onDraftTaken={() => s.setDraft(undefined)}
      />
    );
  },
});

function IntegrationsScreen({ selectedId }: { selectedId: string | undefined }) {
  const { bots, openBotId, integrations, setDraft } = useShell();
  const navigate = useNavigate();
  return (
    <Integrations
      integrations={integrations}
      selectedId={selectedId}
      onSelect={(id) =>
        void (id
          ? navigate({ to: "/integrations/$integrationId", params: { integrationId: id } })
          : navigate({ to: "/integrations" }))
      }
      onTry={
        bots?.length
          ? (text) => {
              const botId = openBotId ?? bots[0].id;
              setDraft({ botId, text });
              void navigate({ to: "/bots/$botId", params: { botId } });
            }
          : undefined
      }
    />
  );
}

const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integrations",
  component: () => <IntegrationsScreen selectedId={undefined} />,
});

const integrationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integrations/$integrationId",
  component: function Integration() {
    return <IntegrationsScreen selectedId={integrationRoute.useParams().integrationId} />;
  },
});

const credentialsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/credentials",
  component: function CredentialsScreen() {
    const { credentials, bots } = useShell();
    return <Credentials credentials={credentials} bots={bots ?? []} />;
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    botRoute,
    integrationsRoute,
    integrationRoute,
    credentialsRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
