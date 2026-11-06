import { BotIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { AppBar } from "./page.tsx";

/** Shown when no bot is open: a first-run prompt, or a nudge to pick one. */
export function Welcome({ loading, hasBots, onNewBot }: { loading: boolean; hasBots: boolean; onNewBot: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppBar>
        <h1 className="text-sm font-medium">claudebot</h1>
      </AppBar>
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>{hasBots ? "Pick a bot" : "Create your first bot"}</EmptyTitle>
            <EmptyDescription>
              Each bot is one long-running conversation dedicated to one job. It keeps its own memory, files and routines, and can hand work to other bots.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onNewBot}>
              <PlusIcon /> New bot
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </div>
  );
}
