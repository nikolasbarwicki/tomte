import type { IncomingMessage, ServerResponse } from "node:http";

import type { LiveMessage } from "@claudebot/contract/events";
import { z } from "zod";

import type { HostOrigin } from "../platform/config.ts";
import type { BotBrowser, BrowserRuntimes } from "./runtime.ts";
import type { Takeover } from "./takeover.ts";
import { BotRef, guardUiRequest, rejectRequest } from "./ui-guard.ts";

export const LIVE_VIEW_PATH = "/api/browser/live";

export interface LiveViewOptions {
  /** Where the host is reachable; Host and Origin must name it. */
  host: HostOrigin;
  isEnabled(botId: string): boolean;
  runtimes: BrowserRuntimes;
  takeover: Takeover;
  /** Frame cap per viewer. Default 15. */
  maxFps?: number;
  /** How often a stopped or unreachable stream is checked again. Default 1000. */
  retryMs?: number;
}

const DEFAULT_FPS = 15;
const DEFAULT_RETRY_MS = 1000;

/** A size the engine reports; missing or not a number reads as 0. */
const size = z.coerce.number().catch(0);
/** A label the engine reports; missing or not text reads as "". */
const label = z.union([z.string(), z.number()]).transform(String).catch("");
const EngineTab = z
  .object({ tabId: label, title: label, url: label, active: z.unknown() })
  .transform((t) => ({ id: t.tabId, title: t.title, url: t.url, active: t.active === true }))
  .catch({ id: "", title: "", url: "", active: false });

/** The engine stream messages viewers get, mapped to `LiveMessage`; anything else is dropped. */
const EngineMessage = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("frame"),
      data: z.string(),
      metadata: z
        .object({ deviceWidth: size, deviceHeight: size })
        .catch({ deviceWidth: 0, deviceHeight: 0 }),
    })
    .transform((m): LiveMessage => ({
      type: "frame",
      data: m.data,
      width: m.metadata.deviceWidth,
      height: m.metadata.deviceHeight,
    })),
  z
    .object({ type: z.literal("url"), url: z.string() })
    .transform((m): LiveMessage => ({ type: "url", url: m.url })),
  z
    .object({ type: z.literal("tabs"), tabs: z.array(EngineTab) })
    .transform((m): LiveMessage => ({ type: "tabs", tabs: m.tabs })),
  z
    .object({ type: z.literal("status"), viewportWidth: size, viewportHeight: size })
    .transform((m): LiveMessage => ({
      type: "status",
      viewport: { width: m.viewportWidth, height: m.viewportHeight },
    })),
]);

function toLiveMessage(raw: unknown): LiveMessage | undefined {
  if (typeof raw !== "string") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = EngineMessage.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

/** One viewer: holds at most the newest message of each type, so a slow connection never builds a backlog. */
class Viewer {
  private pending = new Map<LiveMessage["type"], LiveMessage>();
  private waiting = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private res: ServerResponse,
    private minIntervalMs: number,
  ) {
    res.on("close", () => this.close());
  }

  offer(m: LiveMessage) {
    if (this.closed) return;
    this.pending.set(m.type, m);
    this.flush();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.pending.clear();
  }

  private flush() {
    if (this.waiting || this.closed || this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    let drained = true;
    for (const m of batch) drained = this.res.write(`data: ${JSON.stringify(m)}\n\n`) && drained;
    // Hold further writes until the socket drained and the frame interval passed.
    this.waiting = true;
    let ticks = drained ? 1 : 2;
    const release = () => {
      if (--ticks > 0) return;
      this.waiting = false;
      this.flush();
    };
    this.timer = setTimeout(release, this.minIntervalMs);
    if (!drained) this.res.once("drain", release);
  }
}

/** One bot's relay: connects to the engine's stream while anyone watches, reconnects when the browser starts. */
class Feed {
  viewers = new Set<Viewer>();
  private last = new Map<LiveMessage["type"], LiveMessage>();
  private abort = new AbortController();
  private socket: WebSocket | undefined;

  constructor(
    private browser: BotBrowser,
    private retryMs: number,
    private onIdle: () => void,
    private holder: () => LiveMessage,
  ) {
    void this.run();
  }

  add(v: Viewer) {
    this.viewers.add(v);
    v.offer(this.holder());
    for (const m of this.last.values()) v.offer(m);
  }

  remove(v: Viewer) {
    this.viewers.delete(v);
    if (this.viewers.size > 0) return;
    this.abort.abort();
    this.socket?.close();
    this.onIdle();
  }

  /** Sends one user input event to the engine's stream; false when the browser is not streaming. */
  sendInput(message: string): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(message);
    return true;
  }

  publish(m: LiveMessage) {
    this.last.set(m.type, m);
    for (const v of this.viewers) v.offer(m);
  }

  private stopped() {
    this.last.clear();
    this.publish({ type: "state", state: "stopped" });
  }

  private sleep(ms: number) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const t = setTimeout(resolve, ms);
    this.abort.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    return promise;
  }

  private async run() {
    while (!this.abort.signal.aborted) {
      const port = this.browser.active()
        ? await this.browser.streamPort().catch(() => undefined)
        : undefined;
      if (port !== undefined && !this.abort.signal.aborted) await this.relay(port);
      if (this.abort.signal.aborted) return;
      this.stopped();
      await this.sleep(this.retryMs);
    }
  }

  private relay(port: number) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket = ws;
    ws.onopen = () => this.publish({ type: "state", state: "live" });
    ws.onmessage = (e) => {
      const m = toLiveMessage(e.data);
      if (m) this.publish(m);
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => resolve();
    return promise;
  }
}

export interface LiveView {
  /** Serves a request to `LIVE_VIEW_PATH`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Forwards one user input event (already validated) to the bot's browser; false when it is not streaming. Never logged. */
  sendInput(botId: string, message: string): boolean;
  /** Ends every viewer and relay. */
  close(): void;
}

export function createLiveView(o: LiveViewOptions): LiveView {
  const feeds = new Map<string, Feed>();
  const minIntervalMs = 1000 / (o.maxFps ?? DEFAULT_FPS);
  const responses = new Set<ServerResponse>();
  o.takeover.subscribe((botId, holder) => feeds.get(botId)?.publish({ type: "control", holder }));

  return {
    async handle(req, res) {
      const body = await guardUiRequest(req, res, o.host);
      if (!body) return;
      const ref = BotRef.safeParse(body);
      if (!ref.success) return rejectRequest(res, 400, "botId required");
      const { botId } = ref.data;
      if (!o.isEnabled(botId))
        return rejectRequest(res, 403, "the browser is switched off for this bot");

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const viewer = new Viewer(res, minIntervalMs);
      let feed = feeds.get(botId);
      if (!feed) {
        feed = new Feed(
          o.runtimes.forBot(botId),
          o.retryMs ?? DEFAULT_RETRY_MS,
          () => feeds.delete(botId),
          () => ({ type: "control", holder: o.takeover.holder(botId) }),
        );
        feeds.set(botId, feed);
      }
      responses.add(res);
      const f = feed;
      f.add(viewer);
      res.on("close", () => {
        responses.delete(res);
        f.remove(viewer);
      });
    },
    sendInput: (botId, message) => feeds.get(botId)?.sendInput(message) ?? false,
    close() {
      for (const res of responses) res.end();
    },
  };
}
