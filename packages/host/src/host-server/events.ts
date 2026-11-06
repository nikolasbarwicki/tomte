import type { IncomingMessage, ServerResponse } from "node:http";
import type { BotsEvent, CredentialsEvent, FilesEvent, IntegrationsEvent, MemoryEvent, RoutinesEvent, ServerEvent } from "@claudebot/contract/events";

export type HostEvent = ServerEvent | MemoryEvent | FilesEvent | RoutinesEvent | BotsEvent | IntegrationsEvent | CredentialsEvent;

/** The page's server-sent event stream: every connected page gets every event. */
export interface EventStream {
  broadcast(e: HostEvent): void;
  /** Opens a stream that starts with `snapshot`, then follows every broadcast until the page disconnects. */
  subscribe(req: IncomingMessage, res: ServerResponse, snapshot: HostEvent[]): void;
}

export function createEventStream(): EventStream {
  const clients = new Set<ServerResponse>();
  return {
    broadcast(e) {
      for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`);
    },
    subscribe(req, res, snapshot) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const e of snapshot) res.write(`data: ${JSON.stringify(e)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
    },
  };
}
