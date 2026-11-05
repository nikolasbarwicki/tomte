import { useEffect, useState } from "react";
import type { LiveMessage } from "./events.ts";

type Tab = Extract<LiveMessage, { type: "tabs" }>["tabs"][number];
interface Live {
  live: boolean;
  frame?: string;
  url?: string;
  tabs: Tab[];
}

/** Follows a bot's browser through the per-bot live stream. Opening it never starts the browser. */
function useLive(botId: string): Live {
  const [state, setState] = useState<Live>({ live: false, tabs: [] });
  useEffect(() => {
    const abort = new AbortController();
    setState({ live: false, tabs: [] });
    const apply = (m: LiveMessage) =>
      setState((s) => {
        if (m.type === "state") return m.state === "live" ? { ...s, live: true } : { live: false, tabs: [] };
        if (m.type === "frame") return { ...s, frame: m.data };
        if (m.type === "url") return { ...s, url: m.url };
        if (m.type === "tabs") return { ...s, tabs: m.tabs };
        return s;
      });
    (async () => {
      // A POST: the host only serves this stream to same-origin JSON requests.
      while (!abort.signal.aborted) {
        try {
          const res = await fetch("/api/browser/live", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ botId }), signal: abort.signal });
          if (!res.ok || !res.body) throw new Error(String(res.status));
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const parts = (buffer + value).split("\n\n");
            buffer = parts.pop() ?? "";
            for (const p of parts) apply(JSON.parse(p.replace(/^data: /, "")) as LiveMessage);
          }
        } catch {
          if (abort.signal.aborted) return;
        }
        setState({ live: false, tabs: [] });
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => abort.abort();
  }, [botId]);
  return state;
}

/** View-only Browser panel; the bot is in control. */
export function BrowserPanel({ botId }: { botId: string }) {
  const { live, frame, url: navigated, tabs } = useLive(botId);
  // The engine sends no URL on connect, so the active tab's address fills in until the first navigation.
  const url = tabs.find((t) => t.active)?.url || navigated;
  return (
    <div className="browser-panel">
      <h3>Browser</h3>
      {live ? (
        <>
          {tabs.length > 0 && (
            <div className="browser-tabs">
              {tabs.map((t) => (
                <span key={t.id} className={t.active ? "active" : ""} title={t.url}>
                  {t.title || t.url || t.id}
                </span>
              ))}
            </div>
          )}
          <div className="browser-url" title={url}>{url ?? ""}</div>
          {frame ? <img className="browser-frame" alt="The bot's browser" src={`data:image/jpeg;base64,${frame}`} /> : <p className="meta">Waiting for the page…</p>}
          <p className="meta">Bot is in control · view only</p>
        </>
      ) : (
        <p className="meta browser-placeholder">The browser is not running. It starts when the bot first uses it.</p>
      )}
    </div>
  );
}
