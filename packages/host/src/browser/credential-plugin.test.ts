import { afterEach, describe, expect, test } from "bun:test";

import { answerCredentialPlugin } from "./credential-plugin.ts";

const PROTOCOL = "agent-browser.plugin.v1";
const resolve = JSON.stringify({
  protocol: PROTOCOL,
  type: "credential.resolve",
  request: { itemRef: "nonce-1", url: "https://example.com/login" },
});

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true);
});

/** A stand-in for the host's credential exchange; records what the plugin posted. */
function exchange(handler: (body: unknown) => Response) {
  const posted: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body: unknown = await req.json();
      posted.push(body);
      return handler(body);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/exchange`, posted };
}

const answer = async (url: string, request: string) =>
  JSON.parse(await answerCredentialPlugin(url, request)) as Record<string, unknown>;

describe("the credential plugin", () => {
  test("answers the manifest request without calling the host", async () => {
    const { url, posted } = exchange(() => new Response("{}"));
    const reply = await answer(
      url,
      JSON.stringify({ protocol: PROTOCOL, type: "plugin.manifest" }),
    );
    expect(reply).toEqual({
      protocol: PROTOCOL,
      success: true,
      manifest: { name: "tomte", capabilities: ["credential.read"] },
    });
    expect(posted).toEqual([]);
  });

  test("hands the engine the credential the host grants for the nonce", async () => {
    const credential = { username: "ada", password: "pw", url: "https://example.com/login" };
    const { url, posted } = exchange(() => Response.json(credential));
    expect(await answer(url, resolve)).toEqual({ protocol: PROTOCOL, success: true, credential });
    expect(posted).toEqual([{ nonce: "nonce-1", url: "https://example.com/login" }]);
  });

  test("says denied when the host refuses or answers something else", async () => {
    const refused = exchange(() => new Response("no", { status: 403 }));
    expect(await answer(refused.url, resolve)).toMatchObject({ success: false, error: "denied" });
    const odd = exchange(() => Response.json({ username: "ada" }));
    expect(await answer(odd.url, resolve)).toMatchObject({ success: false, error: "denied" });
  });

  test("says the host is unreachable when the exchange is down", async () => {
    expect(await answer("http://127.0.0.1:1/exchange", resolve)).toMatchObject({
      success: false,
      error: "host unreachable",
    });
  });

  test("refuses what it does not understand", async () => {
    const { url } = exchange(() => new Response("{}"));
    expect(await answer(url, "not json")).toMatchObject({ error: "invalid request" });
    expect(
      await answer(url, JSON.stringify({ protocol: "other.v9", type: "plugin.manifest" })),
    ).toMatchObject({
      error: "unsupported protocol",
    });
    expect(
      await answer(url, JSON.stringify({ protocol: PROTOCOL, type: "credential.list" })),
    ).toMatchObject({
      error: "unsupported request",
    });
  });
});
