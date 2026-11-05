import { useEffect, useRef, useState } from "react";
import { post } from "./api.ts";
import type { LiveMessage } from "./events.ts";

type Tab = Extract<LiveMessage, { type: "tabs" }>["tabs"][number];
interface Live {
  live: boolean;
  frame?: string;
  /** Size of the page in the frame, which input coordinates refer to. */
  size?: { width: number; height: number };
  url?: string;
  tabs: Tab[];
  holder: "bot" | "draining" | "user";
}

/** Follows a bot's browser through the per-bot live stream. Opening it never starts the browser. */
function useLive(botId: string): Live {
  const [state, setState] = useState<Live>({ live: false, tabs: [], holder: "bot" });
  useEffect(() => {
    const abort = new AbortController();
    setState({ live: false, tabs: [], holder: "bot" });
    const apply = (m: LiveMessage) =>
      setState((s) => {
        if (m.type === "state") return m.state === "live" ? { ...s, live: true } : { ...s, live: false, frame: undefined, tabs: [] };
        if (m.type === "frame") return { ...s, frame: m.data, size: { width: m.width, height: m.height } };
        if (m.type === "control") return { ...s, holder: m.holder };
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
        setState({ live: false, tabs: [], holder: "bot" });
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => abort.abort();
  }, [botId]);
  return state;
}

const MODIFIERS = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTONS = ["left", "middle", "right"] as const;

/** Sends input to the bot's browser while the user holds control. Events are fire-and-forget and never kept. */
function useInput(botId: string, size: Live["size"]) {
  const frame = useRef<HTMLImageElement>(null);
  const lastMove = useRef(0);
  const send = (event: Record<string, unknown>) => void post("/api/browser/input", { botId, ...event }).catch(() => undefined);
  const point = (clientX: number, clientY: number) => {
    const r = frame.current?.getBoundingClientRect();
    if (!r || !size || !r.width || !r.height) return undefined;
    return { x: ((clientX - r.left) / r.width) * size.width, y: ((clientY - r.top) / r.height) * size.height };
  };
  const mouse = (eventType: string, e: React.MouseEvent, extra: Record<string, unknown> = {}) => {
    const p = point(e.clientX, e.clientY);
    if (p) send({ kind: "mouse", eventType, ...p, modifiers: MODIFIERS(e), ...extra });
  };
  const touch = (eventType: string, e: React.TouchEvent) => {
    const touchPoints = Array.from(e.touches).map((t) => point(t.clientX, t.clientY)).filter((p) => p !== undefined);
    send({ kind: "touch", eventType, touchPoints });
  };
  return {
    frame,
    handlers: {
      onMouseMove: (e: React.MouseEvent) => {
        if (Date.now() - lastMove.current < 40) return;
        lastMove.current = Date.now();
        mouse("mouseMoved", e, { button: e.buttons ? BUTTONS[Math.min(e.button, 2)] : "none" });
      },
      onMouseDown: (e: React.MouseEvent) => mouse("mousePressed", e, { button: BUTTONS[Math.min(e.button, 2)], clickCount: e.detail || 1 }),
      onMouseUp: (e: React.MouseEvent) => mouse("mouseReleased", e, { button: BUTTONS[Math.min(e.button, 2)], clickCount: e.detail || 1 }),
      onWheel: (e: React.WheelEvent) => mouse("mouseWheel", e, { deltaX: e.deltaX, deltaY: e.deltaY }),
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      onTouchStart: (e: React.TouchEvent) => touch("touchStart", e),
      onTouchMove: (e: React.TouchEvent) => touch("touchMove", e),
      onTouchEnd: (e: React.TouchEvent) => touch("touchEnd", e),
      onTouchCancel: (e: React.TouchEvent) => touch("touchCancel", e),
    },
    keys: {
      onKeyDown: (e: React.KeyboardEvent) => {
        e.preventDefault();
        const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
        send({ kind: "keyboard", eventType: "keyDown", key: e.key, code: e.code, text: printable ? e.key : undefined, windowsVirtualKeyCode: e.keyCode, modifiers: MODIFIERS(e) });
      },
      onKeyUp: (e: React.KeyboardEvent) => {
        e.preventDefault();
        send({ kind: "keyboard", eventType: "keyUp", key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: MODIFIERS(e) });
      },
    },
  };
}

/** The bot's browser: a live view, the controls for taking it over, and the host actions for restarting it. */
export function BrowserPanel({ botId, botName, headed }: { botId: string; botName: string; headed: boolean }) {
  const { live, frame: data, size, url: navigated, tabs, holder } = useLive(botId);
  const [error, setError] = useState<string>();
  const input = useInput(botId, size);
  // The engine sends no URL on connect, so the active tab's address fills in until the first navigation.
  const url = tabs.find((t) => t.active)?.url || navigated;
  const control = async (action: "take" | "hand_back") => {
    const res = await post("/api/browser/control", { botId, action });
    setError(res.ok ? undefined : ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `failed (${res.status})`);
  };
  return (
    <div className="browser-panel">
      <h3>Browser</h3>
      <div className="browser-controls">
        <label title="Show the browser window on this computer (restarts the browser)">
          <input type="checkbox" checked={headed} onChange={(e) => post("/api/bots/browser/headed", { botId, headed: e.target.checked })} />
          Show window
        </label>
        <button title="Close the browser; saved logins are kept" onClick={() => post("/api/bots/browser/restart", { botId })}>
          Restart
        </button>
        <button
          title="Close the browser and delete its saved logins"
          onClick={() => confirm(`Sign ${botName} out of everything? Its saved logins will be deleted.`) && post("/api/bots/browser/sign-out", { botId })}
        >
          Sign out of everything
        </button>
      </div>
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
          {data ? (
            <div className={`browser-stage ${holder}`} tabIndex={holder === "user" ? 0 : -1} {...(holder === "user" ? input.keys : {})}>
              <img ref={input.frame} className="browser-frame" alt="The bot's browser" draggable={false} src={`data:image/jpeg;base64,${data}`} {...(holder === "user" ? input.handlers : {})} />
            </div>
          ) : (
            <p className="meta">Waiting for the page…</p>
          )}
          <div className="browser-takeover">
            {holder === "user" ? (
              <>
                <button className="primary" onClick={() => control("hand_back")}>Hand back</button>
                <span className="meta">You have control · click the page to type</span>
              </>
            ) : (
              <>
                <button disabled={holder === "draining"} onClick={() => control("take")}>{holder === "draining" ? "Taking control…" : "Take control"}</button>
                <span className="meta">Bot is in control</span>
              </>
            )}
          </div>
          {error && <p className="meta browser-error">{error}</p>}
        </>
      ) : (
        <p className="meta browser-placeholder">The browser is not running. It starts when the bot first uses it.</p>
      )}
    </div>
  );
}
