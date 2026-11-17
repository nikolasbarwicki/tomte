import { afterEach, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createRequestListener, type Route } from "./http.ts";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function serve(routes: Route[]): Promise<string> {
  server = createServer(createRequestListener(routes, (_req, res) => res.writeHead(404).end()));
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("a labelled route that throws answers 500 and logs the failure under its label", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const base = await serve([
      {
        match: (p) => p === "/boom",
        handler: async () => {
          throw new Error("kaput");
        },
        label: "[test] failed:",
      },
    ]);
    expect((await fetch(`${base}/boom`)).status).toBe(500);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect(log).toHaveBeenCalledWith("[test] failed: kaput");
  } finally {
    log.mockRestore();
  }
});
