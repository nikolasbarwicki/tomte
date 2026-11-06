import { afterEach, describe, expect, test } from "bun:test";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
afterEach(() => host.stop());

const FORWARDED = {
  "x-forwarded-host": "attacker.example",
  "x-forwarded-proto": "https",
  forwarded: "host=attacker.example;proto=https",
};

/** The OAuth redirect URLs the integrations screen shows, as the web page would fetch them. */
async function redirectUrls(headers: Record<string, string> = {}): Promise<string[]> {
  const res = await fetch(`${host.server.url}/api/integrations/list`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
  const list = (await res.json()) as { redirectUrl: string }[];
  expect(list.length).toBeGreaterThan(0);
  return list.map((i) => i.redirectUrl);
}

describe("the OAuth redirect URL", () => {
  test("is built from the configured public URL, not from forwarded headers", async () => {
    host = await startHandoffHost(["--public-url", "https://claudebot.example.com"]);
    const urls = await redirectUrls(FORWARDED);
    expect(new Set(urls)).toEqual(new Set(["https://claudebot.example.com/oauth/callback"]));
    expect(await redirectUrls()).toEqual(urls);
  });

  test("defaults to the loopback URL of the bound port, whatever the request claims", async () => {
    host = await startHandoffHost();
    expect(new Set(await redirectUrls(FORWARDED))).toEqual(
      new Set([`${host.server.url}/oauth/callback`]),
    );
  });

  test("bots still reach the host on its loopback address when a public URL is set", async () => {
    host = await startHandoffHost(["--public-url", "https://claudebot.example.com"]);
    const bot = host.createBot("alice");
    const act = await host.actAs(bot);
    expect(act.url).toBe(`${host.server.url}/mcp/bots`);
    expect((await act.call("list_bots")).isError).toBe(false);
  });
});
