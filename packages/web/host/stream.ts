import { toast } from "sonner";
import { post } from "./api.ts";
import type { HostStore } from "./store.ts";
import type { StreamEvent } from "./state.ts";

/** Loads the host's info, then mirrors its event stream into `store`. Returns the cleanup that closes the stream. */
export function connectHostStream(store: HostStore, { onReset }: { onReset(previous: string | undefined, next: string): void }): () => void {
  post("/api/info", {}).then(async (r) => store.dispatch({ type: "host-info", info: await r.json() }));
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    const e = JSON.parse(m.data) as StreamEvent;
    if (e.type === "notify" && Date.now() - e.at < 5_000) toast(e.title, { description: e.body || undefined });
    if (e.type === "reset") {
      const previous = store.get().openBotId;
      store.dispatch(e);
      onReset(previous, e.botId);
      return;
    }
    store.dispatch(e);
  };
  return () => es.close();
}
