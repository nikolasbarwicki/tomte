import { BotsEvent, type BotSummary } from "@claudebot/contract/events";

import type { HostFetch } from "./host-api.ts";

const FIRST_RETRY_MS = 1_000;
const LONGEST_RETRY_MS = 30_000;

export interface BotsFollower {
  stop(): void;
}

/**
 * Follows a host's server-sent event stream (`GET /api/events`) with a device token and reports every `bots` slice. The
 * stream also carries chats, memory and credentials; those events are skipped without being parsed against any schema,
 * so the app reads nothing but what the banner needs. A stream that ends or fails is opened again after a pause that
 * doubles up to 30 seconds. `onOpen` runs each time one is open, before its first event, so a consumer can tell a fresh
 * snapshot from a change.
 */
export function followBots(
  target: { origin: string; token: string },
  deps: {
    fetch: HostFetch;
    onOpen(): void;
    onBots(bots: BotSummary[]): void;
    /** Why the stream is down, once per outage. */
    onDown(reason: string): void;
  },
): BotsFollower {
  const controller = new AbortController();
  const { signal } = controller;
  let opened = false;

  async function readStream(): Promise<void> {
    const response = await deps.fetch(`${target.origin}/api/events`, {
      method: "GET",
      headers: { authorization: `Bearer ${target.token}`, accept: "text/event-stream" },
      credentials: "omit",
      redirect: "error",
      signal,
    });
    if (!response.ok || response.body === null)
      throw new Error(`the host answered HTTP ${response.status}`);
    deps.onOpen();
    opened = true;
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        handle(pending.slice(0, end));
        pending = pending.slice(end + 2);
      }
    }
    throw new Error("the stream ended");
  }

  function handle(block: string): void {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "bots")
      return;
    const bots = BotsEvent.safeParse(event);
    if (bots.success) deps.onBots(bots.data.bots);
  }

  void (async () => {
    let retry = FIRST_RETRY_MS;
    let reported = false;
    while (!signal.aborted) {
      opened = false;
      try {
        await readStream();
      } catch (error) {
        if (signal.aborted) return;
        if (opened) {
          retry = FIRST_RETRY_MS;
          reported = false;
        }
        if (!reported) deps.onDown(error instanceof Error ? error.message : String(error));
        reported = true;
      }
      const pause = Promise.withResolvers<void>();
      const timer = setTimeout(pause.resolve, retry);
      signal.addEventListener("abort", () => (clearTimeout(timer), pause.resolve()), {
        once: true,
      });
      await pause.promise;
      retry = Math.min(retry * 2, LONGEST_RETRY_MS);
    }
  })();

  return { stop: () => controller.abort() };
}
