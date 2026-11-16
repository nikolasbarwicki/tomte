import type { HandoffHost } from "./test-host.ts";

type PageEvent = { type: string; [k: string]: unknown };

/** What a page saw on its event stream, by event id and bot id. */
export interface EventsWatch {
  stop(): void;
  /** Every event the stream carried, in order. */
  events(): { type: string; [k: string]: unknown }[];
  rowOf(id: string): { [k: string]: unknown } | undefined;
  stateOf(id: string): unknown;
  /** Source id to Work status, as of the latest `work` event of the bot. */
  status(botId: string): Record<string, string>;
  needsYou(botId: string): number | undefined;
}

/** One page's `/api/events` stream from now on, read as the events it was sent. `stop()` ends it. */
export async function watchEvents(
  host: Pick<HandoffHost, "clientUrl" | "authHeaders">,
): Promise<EventsWatch> {
  const abort = new AbortController();
  const res = await fetch(`${host.clientUrl}/api/events`, {
    signal: abort.signal,
    headers: host.authHeaders,
  });
  const seen: PageEvent[] = [];
  void (async () => {
    const reader = res.body!.getReader();
    let text = "";
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        text += new TextDecoder().decode(r.value);
        const parts = text.split("\n\n");
        text = parts.pop() ?? "";
        for (const p of parts) if (p.startsWith("data: ")) seen.push(JSON.parse(p.slice(6)));
      }
    } catch {
      // The test ended the stream.
    }
  })();
  return {
    stop: () => abort.abort(),
    events: () => [...seen],
    rowOf: (id: string) => seen.find((e) => e.type === "external" && e.id === id),
    stateOf: (id: string) =>
      seen
        .filter((e) => (e.type === "external" || e.type === "external_state") && e.id === id)
        .at(-1)?.state,
    status(botId: string) {
      const work = seen.filter((e) => e.type === "work" && e.botId === botId).at(-1) as
        | { sources: { id: string; status: string }[] }
        | undefined;
      return Object.fromEntries(work?.sources.map((s) => [s.id, s.status]) ?? []);
    },
    needsYou(botId: string) {
      const bots = seen.filter((e) => e.type === "bots").at(-1) as
        | { bots: { id: string; needsYou: number }[] }
        | undefined;
      return bots?.bots.find((b) => b.id === botId)?.needsYou;
    },
  };
}
