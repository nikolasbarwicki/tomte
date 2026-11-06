import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Listener {
  http: Server;
  /** The bound port; known as soon as the socket opens. */
  port: number;
  /** Starts answering requests with `serve`; until then, and after `stop`, every request gets 503. */
  serve(handler: RequestListener): void;
  /** Answers 503 again, before the rest of the host shuts down. */
  pause(): void;
  /** Drops every connection and stops listening. */
  stop(): Promise<void>;
}

/** Opens a listening socket on `address`:`port` (port 0 picks a free one). Nothing is served until `serve` is called. */
export async function openListener(address: string, port: number): Promise<Listener> {
  let handler: RequestListener | undefined;
  const http = createServer((req, res) =>
    handler ? handler(req, res) : void res.writeHead(503).end(),
  );
  const listening = Promise.withResolvers<void>();
  http.once("error", listening.reject);
  http.listen(port, address, listening.resolve);
  await listening.promise;
  return {
    http,
    port: (http.address() as AddressInfo).port,
    serve: (h) => {
      handler = h;
    },
    pause: () => {
      handler = undefined;
    },
    async stop() {
      http.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      http.close(() => closed.resolve());
      await closed.promise;
    },
  };
}
