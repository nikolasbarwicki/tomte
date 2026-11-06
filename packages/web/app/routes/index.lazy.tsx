import { createLazyRoute, Navigate } from "@tanstack/react-router";

import { useBots, useOpenBotId } from "@/host/hooks.ts";

import { useNewBot } from "../shell.tsx";
import { Welcome } from "../welcome.tsx";

/** Lands on the chat the host is showing, or welcomes the user when there is none. */
export const Route = createLazyRoute("/")({
  component: function Home() {
    const bots = useBots();
    const openBotId = useOpenBotId();
    const newBot = useNewBot();
    if (openBotId && bots?.some((b) => b.id === openBotId))
      return <Navigate to="/bots/$botId" params={{ botId: openBotId }} replace />;
    return <Welcome loading={!bots} hasBots={!!bots?.length} onNewBot={newBot} />;
  },
});
