import { HostInfo } from "@claudebot/contract/api";
import { HostEvent } from "@claudebot/contract/events";
import { toast } from "sonner";

import { parseJson, post, probeSession, readJson } from "./api.ts";
import type { HostStore } from "./store.ts";

/** Loads the host's info, then mirrors its event stream into `store`. Returns the cleanup that closes the stream. */
export function connectHostStream(
  store: HostStore,
  { onReset }: { onReset: (previous: string | undefined, next: string) => void },
): () => void {
  void post("/api/info", {}).then(async (r) =>
    store.dispatch({ type: "host-info", info: await readJson(r, HostInfo) }),
  );
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    const e = parseJson(m.data, HostEvent, "/api/events");
    if (e.type === "notify" && Date.now() - e.at < 5_000)
      toast(e.title, { description: e.body || undefined });
    if (e.type === "reset") {
      const previous = store.get().openBotId;
      store.dispatch(e);
      onReset(previous, e.botId);
      return;
    }
    store.dispatch(e);
  };
  // EventSource cannot see the status: a 401 closes it for good, so ask whether the device was revoked.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) void probeSession();
  };
  return () => es.close();
}
