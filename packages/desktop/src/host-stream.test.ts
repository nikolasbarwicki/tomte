import { describe, expect, test } from "bun:test";

import type { BotSummary } from "@tomte/contract/events";
import type { HostStatus } from "@tomte/contract/host-status";

import { followHost } from "./host-stream.ts";

const status: HostStatus = {
  version: "0.1.0",
  mode: "remote",
  claude: { state: "signed-out", ignoredEnv: [], checkedAt: 1 },
  update: { status: "unmanaged", reason: "x" },
  autoUpdate: false,
  problems: [{ kind: "claude-signed-out" }],
};
const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

describe("following a host's event stream", () => {
  test("reports bots and host-status, skips every other event and what does not parse, once per target", async () => {
    const seen: string[] = [];
    const requests: { url: string; headers: unknown }[] = [];
    const done = Promise.withResolvers<void>();
    const chunks = [
      sse({ type: "chat", chat: { secret: true } }),
      "data: not json\n\n",
      sse({ type: "bots", bots: [] }),
      sse({ type: "bots", bots: "wrong" }),
      sse({ type: "host-status", status }),
      sse({ type: "host-status", status: { version: 1 } }),
      ": comment\n\n",
    ];
    const follower = followHost(
      { origin: "https://vps.example.com", token: "tok" },
      {
        async fetch(url, init) {
          requests.push({ url, headers: init.headers });
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              // Split a block across two chunks to see that framing survives it.
              const all = chunks.join("");
              controller.enqueue(encoder.encode(all.slice(0, 40)));
              controller.enqueue(encoder.encode(all.slice(40)));
              controller.close();
            },
          });
          return new Response(body, { status: 200 });
        },
        onOpen: () => void seen.push("open"),
        onBots: (bots: BotSummary[]) => void seen.push(`bots ${bots.length}`),
        onStatus: (s) => void seen.push(`status ${s.problems.length}`),
        onDown(reason) {
          seen.push(`down ${reason}`);
          done.resolve();
        },
      },
    );
    await done.promise;
    follower.stop();
    expect(seen).toEqual(["open", "bots 0", "status 1", "down the stream ended"]);
    expect(requests).toEqual([
      {
        url: "https://vps.example.com/api/events",
        headers: { authorization: "Bearer tok", accept: "text/event-stream" },
      },
    ]);
  });

  test("an HTTP refusal is reported as down", async () => {
    const down = Promise.withResolvers<string>();
    const follower = followHost(
      { origin: "https://vps.example.com", token: "bad" },
      {
        fetch: async () => new Response("no", { status: 401 }),
        onOpen: () => {},
        onBots: () => {},
        onStatus: () => {},
        onDown: down.resolve,
      },
    );
    expect(await down.promise).toBe("the host answered HTTP 401");
    follower.stop();
  });
});
