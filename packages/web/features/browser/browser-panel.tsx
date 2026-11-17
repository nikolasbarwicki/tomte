import { LiveMessage } from "@tomte/contract/events";
import {
  EllipsisIcon,
  GlobeIcon,
  HandIcon,
  LogOutIcon,
  MousePointerClickIcon,
  RotateCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

import { confirmAction } from "@/components/confirm.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { errorOf, parseJson } from "@/host/api.ts";
import { usePublicHostInfo } from "@/host/hooks.ts";
import { cn } from "@/lib/utils";

import {
  controlBrowser,
  restartBrowser,
  sendBrowserInput,
  setBrowserHeaded,
  signOutBrowser,
} from "./api.ts";

type Tab = Extract<LiveMessage, { type: "tabs" }>["tabs"][number];
interface Live {
  live: boolean;
  frame?: string | undefined;
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
    const apply = (m: LiveMessage) =>
      setState((s) => {
        if (m.type === "state")
          return m.state === "live"
            ? { ...s, live: true }
            : { ...s, live: false, frame: undefined, tabs: [] };
        if (m.type === "frame")
          return { ...s, frame: m.data, size: { width: m.width, height: m.height } };
        if (m.type === "control") return { ...s, holder: m.holder };
        if (m.type === "url") return { ...s, url: m.url };
        if (m.type === "tabs") return { ...s, tabs: m.tabs };
        return s;
      });
    void (async () => {
      // A POST: the host only serves this stream to same-origin JSON requests.
      while (!abort.signal.aborted) {
        try {
          const res = await fetch("/api/browser/live", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ botId }),
            signal: abort.signal,
          });
          if (!res.ok || !res.body) throw new Error(String(res.status));
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const parts = (buffer + value).split("\n\n");
            buffer = parts.pop() ?? "";
            for (const p of parts)
              apply(parseJson(p.replace(/^data: /, ""), LiveMessage, "/api/browser/live"));
          }
        } catch {
          if (abort.signal.aborted) return;
        }
        setState({ live: false, tabs: [], holder: "bot" });
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      abort.abort();
      setState({ live: false, tabs: [], holder: "bot" });
    };
  }, [botId]);
  return state;
}

const MODIFIERS = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTONS = ["left", "middle", "right"] as const;

/** Sends input to the bot's browser while the user holds control. Events are fire-and-forget and never kept. */
function useInput(botId: string, size: Live["size"]) {
  const frame = useRef<HTMLImageElement>(null);
  const lastMove = useRef(0);
  const send = (event: Record<string, unknown>) => sendBrowserInput(botId, event);
  const point = (clientX: number, clientY: number) => {
    const r = frame.current?.getBoundingClientRect();
    if (!r || !size || !r.width || !r.height) return undefined;
    return {
      x: ((clientX - r.left) / r.width) * size.width,
      y: ((clientY - r.top) / r.height) * size.height,
    };
  };
  const mouse = (eventType: string, e: React.MouseEvent, extra: Record<string, unknown> = {}) => {
    const p = point(e.clientX, e.clientY);
    if (p) send({ kind: "mouse", eventType, ...p, modifiers: MODIFIERS(e), ...extra });
  };
  const touch = (eventType: string, e: React.TouchEvent) => {
    const touchPoints = Array.from(e.touches)
      .map((t) => point(t.clientX, t.clientY))
      .filter((p) => p !== undefined);
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
      onMouseDown: (e: React.MouseEvent) =>
        mouse("mousePressed", e, {
          button: BUTTONS[Math.min(e.button, 2)],
          clickCount: e.detail || 1,
        }),
      onMouseUp: (e: React.MouseEvent) =>
        mouse("mouseReleased", e, {
          button: BUTTONS[Math.min(e.button, 2)],
          clickCount: e.detail || 1,
        }),
      onWheel: (e: React.WheelEvent) =>
        mouse("mouseWheel", e, { deltaX: e.deltaX, deltaY: e.deltaY }),
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
        send({
          kind: "keyboard",
          eventType: "keyDown",
          key: e.key,
          code: e.code,
          text: printable ? e.key : undefined,
          windowsVirtualKeyCode: e.keyCode,
          modifiers: MODIFIERS(e),
        });
      },
      onKeyUp: (e: React.KeyboardEvent) => {
        e.preventDefault();
        send({
          kind: "keyboard",
          eventType: "keyUp",
          key: e.key,
          code: e.code,
          windowsVirtualKeyCode: e.keyCode,
          modifiers: MODIFIERS(e),
        });
      },
    },
  };
}

/** The bot's browser: a live view, the controls for taking it over, and the host actions for restarting it. */
export function BrowserPanel({
  botId,
  botName,
  headed,
}: {
  botId: string;
  botName: string;
  headed: boolean;
}) {
  const { live, frame: data, size, url: navigated, tabs, holder } = useLive(botId);
  const [error, setError] = useState<string>();
  const { frame: frameRef, handlers, keys } = useInput(botId, size);
  // The engine sends no URL on connect, so the active tab's address fills in until the first navigation.
  const url = tabs.find((t) => t.active)?.url || navigated;
  const [controlling, startControl] = useTransition();
  const [configuring, configure] = useTransition();
  const canShowWindow = usePublicHostInfo()?.capabilities.headedBrowser === true;
  const control = (action: "take" | "hand_back") =>
    startControl(async () => {
      const res = await controlBrowser(botId, action);
      setError(res.ok ? undefined : await errorOf(res));
    });
  const signOut = async () => {
    const ok = await confirmAction({
      title: `Sign ${botName} out of everything?`,
      description: "The browser closes and its saved logins are deleted.",
      action: "Sign out",
      destructive: true,
    });
    if (ok)
      configure(async () => {
        await signOutBrowser(botId);
      });
  };
  const userHolds = holder === "user";
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            !live ? "bg-muted-foreground/40" : userHolds ? "bg-blue-500" : "bg-emerald-500",
          )}
        />
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {!live
            ? "Not running"
            : userHolds
              ? "You have control"
              : holder === "draining"
                ? "Handing control to you…"
                : `${botName} is in control`}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={configuring}
                aria-label="Browser settings"
              />
            }
          >
            {configuring ? <Spinner /> : <EllipsisIcon />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {canShowWindow && (
              <DropdownMenuCheckboxItem
                checked={headed}
                onCheckedChange={(checked) =>
                  configure(async () => {
                    await setBrowserHeaded(botId, checked);
                  })
                }
              >
                Show window
              </DropdownMenuCheckboxItem>
            )}
            <DropdownMenuItem
              onClick={() =>
                configure(async () => {
                  await restartBrowser(botId);
                })
              }
            >
              <RotateCwIcon /> Restart browser
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void signOut()}>
              <LogOutIcon /> Sign out of everything
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {live ? (
        <>
          <div className="overflow-hidden rounded-lg border">
            {tabs.length > 1 && (
              <div className="bg-muted/60 flex gap-1 overflow-x-auto border-b px-1.5 pt-1.5">
                {tabs.map((t) => (
                  <span
                    key={t.id}
                    title={t.url}
                    className={cn(
                      "max-w-40 shrink-0 truncate rounded-t-md px-2.5 py-1 text-xs",
                      t.active ? "bg-background font-medium" : "text-muted-foreground",
                    )}
                  >
                    {t.title || t.url || t.id}
                  </span>
                ))}
              </div>
            )}
            <div className="bg-muted/30 text-muted-foreground flex items-center gap-2 border-b px-2.5 py-1.5 text-xs">
              <GlobeIcon className="size-3.5 shrink-0" />
              <span className="truncate" title={url}>
                {url ?? ""}
              </span>
            </div>
            {data ? (
              <div
                className={cn(
                  "leading-none outline-none",
                  userHolds && "cursor-crosshair ring-2 ring-blue-500 ring-inset",
                )}
                tabIndex={userHolds ? 0 : -1}
                {...(userHolds ? keys : {})}
              >
                <img
                  ref={frameRef}
                  className={cn("block w-full", userHolds && "touch-none select-none")}
                  alt="The bot's browser"
                  draggable={false}
                  src={`data:image/jpeg;base64,${data}`}
                  {...(userHolds ? handlers : {})}
                />
              </div>
            ) : (
              <div className="text-muted-foreground flex aspect-video items-center justify-center gap-2 text-xs">
                <Spinner /> Waiting for the page…
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {userHolds ? (
              <>
                <Button size="sm" disabled={controlling} onClick={() => control("hand_back")}>
                  {controlling ? <Spinner /> : <HandIcon />} Hand back
                </Button>
                <span className="text-muted-foreground text-xs">
                  Click the page to type into it.
                </span>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={holder === "draining" || controlling}
                  onClick={() => control("take")}
                >
                  {holder === "draining" || controlling ? <Spinner /> : <MousePointerClickIcon />}
                  {holder === "draining" ? "Taking control…" : "Take control"}
                </Button>
                <span className="text-muted-foreground text-xs">
                  View only while the bot is in control.
                </span>
              </>
            )}
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
        </>
      ) : (
        <Empty className="border border-dashed p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GlobeIcon />
            </EmptyMedia>
            <EmptyTitle className="text-sm">The browser is not running</EmptyTitle>
            <EmptyDescription className="text-xs">
              It starts when {botName} first uses it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
