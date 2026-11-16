import { afterEach, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { withBoundary } from "./boundary.ts";
import { createDeviceSessions } from "./device-sessions.ts";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

test("a presence write that fails is logged and does not fail the request", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const everyone = { namesHost: () => true, namesOrigin: () => true, localUrl: "", publicUrl: "" };
  const listening = Promise.withResolvers<void>();
  server = createServer(
    withBoundary(
      everyone,
      { authenticate: () => "device" },
      createDeviceSessions(),
      {
        touch: () => {
          throw new Error("disk full");
        },
      },
      (_req, res) => void res.writeHead(200).end("served"),
    ),
  ).listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const { port } = server.address() as AddressInfo;

  const res = await fetch(`http://127.0.0.1:${port}/api/info`, {
    headers: { authorization: "Bearer token" },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("served");
  expect(log).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  log.mockRestore();
});
