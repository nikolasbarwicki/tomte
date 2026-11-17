import { BriefcaseIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { useWork } from "@/host/hooks.ts";

import { SourceDetail } from "./detail.tsx";
import { EventsEndpoint } from "./endpoint.tsx";
import { sortSources } from "./model.ts";
import { SourceCard } from "./source-card.tsx";

/** The current time, refreshed so "2m ago" stays true while the panel is open. */
function useNow(everyMs: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** The Work tab: one card per event source of the bot, most urgent first, and how to connect a script. */
export function Work({ botId }: { botId: string }) {
  const work = useWork();
  const now = useNow(15_000);
  const sources = work?.botId === botId ? work.sources : undefined;
  const sorted = useMemo(() => sources && sortSources(sources), [sources]);
  const [openId, setOpenId] = useState<string>();
  const opened = sources?.find((s) => s.id === openId);
  // A source that is archived, here or on another device, closes its detail for good: if it posts again, it shows as a card.
  if (openId !== undefined && sources && !opened) setOpenId(undefined);
  return (
    <div className="grid gap-4">
      {opened ? (
        <SourceDetail botId={botId} source={opened} now={now} onBack={() => setOpenId(undefined)} />
      ) : !sorted ? (
        <div className="flex justify-center p-6">
          <Spinner className="text-muted-foreground" />
        </div>
      ) : sorted.length === 0 ? (
        <Empty className="border border-dashed p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BriefcaseIcon />
            </EmptyMedia>
            <EmptyTitle className="text-sm">No work yet</EmptyTitle>
            <EmptyDescription className="text-xs">
              Scripts and coding agents that report to this bot show up here, one card each.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="grid gap-2">
          {sorted.map((s) => (
            <SourceCard key={s.id} source={s} now={now} onOpen={() => setOpenId(s.id)} />
          ))}
        </ul>
      )}
      <EventsEndpoint key={botId} botId={botId} />
    </div>
  );
}
