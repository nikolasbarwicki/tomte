import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { BROWSER_ENDPOINT_PATH, CREDENTIAL_EXCHANGE_PATH } from "../browser/index.ts";
import { BOTS_ENDPOINT_PATH } from "../handoffs/index.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
beforeEach(async () => {
  host = await startHandoffHost();
});
afterEach(() => host.stop());

const mcpPost = (url: string, token: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("the two listeners", () => {
  test("bind different ports on loopback", () => {
    expect(host.clientUrl).not.toBe(host.agentUrl);
    expect(new URL(host.agentUrl).hostname).toBe("127.0.0.1");
  });

  test("the bots endpoint and the browser endpoint answer on the agent listener only", async () => {
    const bot = host.createBot("alice");
    expect((await host.ui("/api/bots/browser", { botId: bot, enabled: true })).status).toBe(200);
    const lease = host.server.browser.lease(bot);
    const browser = defined(lease.servers[0], "browser server");
    const bots = await host.actAs(bot);

    expect(browser.url).toBe(`${host.agentUrl}${BROWSER_ENDPOINT_PATH}`);
    expect(bots.url).toBe(`${host.agentUrl}${BOTS_ENDPOINT_PATH}`);
    expect((await mcpPost(browser.url, browser.token)).status).toBe(200);
    expect((await mcpPost(bots.url, bots.token)).status).toBe(200);

    // A paired device that passes the boundary check still finds no such route.
    const sameOrigin = { origin: host.clientUrl };
    for (const path of [BROWSER_ENDPOINT_PATH, BOTS_ENDPOINT_PATH])
      expect((await mcpPost(`${host.clientUrl}${path}`, host.deviceToken, sameOrigin)).status).toBe(
        404,
      );
    lease.release();
  });

  test("the credential exchange answers on the agent listener only", async () => {
    const exchange = (base: string) =>
      fetch(`${base}${CREDENTIAL_EXCHANGE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The client listener's boundary check lets a paired same-origin device through to find no route.
          ...(base === host.clientUrl && { origin: base, ...host.authHeaders }),
        },
        body: JSON.stringify({ nonce: "unknown", url: "https://example.com/login" }),
      });
    expect((await exchange(host.agentUrl)).status).toBe(403);
    expect((await exchange(host.clientUrl)).status).toBe(404);
  });

  test("the web API and the OAuth callback answer on the client listener only", async () => {
    const api = (base: string) => fetch(`${base}/api/info`, { headers: host.authHeaders });
    expect((await api(host.clientUrl)).status).toBe(200);
    expect((await api(host.agentUrl)).status).toBe(404);
    expect((await fetch(`${host.agentUrl}/oauth/callback?code=x&state=y`)).status).toBe(404);
    expect(
      (
        await fetch(`${host.agentUrl}/api/browser/live`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: host.agentUrl },
          body: JSON.stringify({ botId: "x" }),
        })
      ).status,
    ).toBe(404);
  });
});
