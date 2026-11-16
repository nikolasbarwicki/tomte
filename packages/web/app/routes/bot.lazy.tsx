import { createLazyRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useMemo } from "react";

import { BotPanel } from "@/features/bots/index.ts";
import { BrowserTab } from "@/features/browser/index.ts";
import { ChatSettings, ChatView } from "@/features/chat/index.ts";
import { MemoryEditor } from "@/features/memory/index.ts";
import { Routines } from "@/features/routines/index.ts";
import { TasksTab } from "@/features/tasks/index.ts";
import { Work } from "@/features/work/index.ts";
import { markSeen, openBot } from "@/host/api.ts";
import { useBots, useOpenBotId } from "@/host/hooks.ts";

import { useNewBot } from "../shell.tsx";
import { Welcome } from "../welcome.tsx";

export const Route = createLazyRoute("/bots/$botId")({
  component: function BotChat() {
    const { botId } = Route.useParams();
    const bots = useBots();
    const openBotId = useOpenBotId();
    const newBot = useNewBot();
    const bot = useMemo(() => bots?.find((b) => b.id === botId), [bots, botId]);
    const shown = !!bot && openBotId === botId;

    // Deliberately not keyed on `openBotId`: when the host moves to another bot, the shell follows it rather than pulling it back.
    const hasBot = !!bot;
    const openBotOnHost = useEffectEvent(() => openBot(botId));
    useEffect(() => {
      if (hasBot) openBotOnHost();
    }, [botId, hasBot]);

    // A finished turn counts as seen once this chat is actually on screen.
    useEffect(() => {
      if (!shown || bot.status !== "unseen") return;
      const seen = () => {
        if (document.visibilityState === "visible") void markSeen(botId);
      };
      seen();
      document.addEventListener("visibilitychange", seen);
      return () => document.removeEventListener("visibilitychange", seen);
    }, [botId, shown, bot?.status]);

    if (bots && !bot) return <Navigate to="/" replace />;
    if (!shown) return <Welcome loading hasBots onNewBot={newBot} />;
    return (
      <ChatView
        key={bot.id}
        bot={bot}
        panel={({ onClose }) => (
          <BotPanel
            bot={bot}
            work={<Work botId={bot.id} />}
            tasks={<TasksTab />}
            browser={<BrowserTab bot={bot} />}
            chat={<ChatSettings bot={bot} />}
            routines={<Routines botId={bot.id} />}
            memory={
              <div className="grid gap-6">
                <MemoryEditor
                  scope="user"
                  title="About you"
                  description="What every bot knows about you. Shared by all bots."
                  empty="Nothing remembered yet."
                />
                <MemoryEditor
                  scope="bot"
                  botId={bot.id}
                  title={`How ${bot.name} works`}
                  description="Directions only this bot follows."
                  empty="No directions yet."
                />
              </div>
            }
            onClose={onClose}
          />
        )}
      />
    );
  },
});
