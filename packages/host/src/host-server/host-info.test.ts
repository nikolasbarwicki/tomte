import { afterEach, describe, expect, test } from "bun:test";
import { request } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PublicHostInfo } from "@tomte/contract/api";

import { getBot, setBrowserEnabled, setBrowserHeaded } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const REMOTE = ["--mode", "remote", "--secrets-key-file", "/etc/tomte-test/secrets.key"];

let host: HandoffHost | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  await host?.stop();
  host = undefined;
});

const start = async (flags: string[] = []) => (host = await startHandoffHost(flags));

/** `GET /api/host-info` with no credentials of any kind. */
async function hostInfo(h: HandoffHost) {
  const res = await fetch(`${h.clientUrl}/api/host-info`);
  return { status: res.status, body: PublicHostInfo.safeParse(await res.json()) };
}

/** A request with a Host header of the caller's choosing, which `fetch` does not allow. */
function statusWithHost(h: HandoffHost, path: string, hostHeader: string) {
  const status = Promise.withResolvers<number | undefined>();
  const req = request(`${h.clientUrl}${path}`, { headers: { host: hostHeader } }, (res) => {
    status.resolve(res.statusCode);
    res.destroy();
  });
  req.on("error", status.reject);
  req.end();
  return status.promise;
}

describe("host-info", () => {
  test("local mode answers without a device token: everything available, no Claude sign-in state", async () => {
    const h = await start();
    const { status, body } = await hostInfo(h);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const info = defined(body.data, "host info");
    expect(info.mode).toBe("local");
    expect(info.apiVersion).toBe(1);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.capabilities).toEqual({ reveal: true, headedBrowser: true, browserSandbox: true });
    expect("claude" in info).toBe(false);
  });

  test("remote mode reports no reveal and no headed Chrome, and the Claude sign-in as the CLI last said", async () => {
    const h = await start(REMOTE);
    await h.until(() => h.server.signInState() === "signed-in");
    const signedIn = defined((await hostInfo(h)).body.data, "host info");
    expect(signedIn.mode).toBe("remote");
    expect(signedIn.claude).toBe("signed-in");
    expect(signedIn.capabilities).toEqual({
      reveal: false,
      headedBrowser: false,
      browserSandbox: true,
    });

    h.setSignedIn(false);
    await h.restart(REMOTE);
    await h.until(() => h.server.signInState() === "signed-out");
    expect(defined((await hostInfo(h)).body.data, "host info").claude).toBe("signed-out");
  });

  test("it carries nothing but version, API version, mode, sign-in state and capabilities", async () => {
    const h = await start(REMOTE);
    const body = (await (await fetch(`${h.clientUrl}/api/host-info`)).json()) as object;
    expect(Object.keys(body).sort()).toEqual([
      "apiVersion",
      "capabilities",
      "claude",
      "mode",
      "version",
    ]);
  });

  test("the Host check still applies, and only a GET skips the device token", async () => {
    const h = await start();
    const port = new URL(h.clientUrl).port;
    expect(await statusWithHost(h, "/api/host-info", `rebind.example:${port}`)).toBe(403);
    expect(await statusWithHost(h, "/api/host-info", `127.0.0.1:${port}`)).toBe(200);
    const post = await fetch(`${h.clientUrl}/api/host-info`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.clientUrl },
      body: "{}",
    });
    expect(post.status).toBe(401);
  });

  test("the agent listener does not serve it", async () => {
    const h = await start();
    expect((await fetch(`${h.agentUrl}/api/host-info`)).status).toBe(404);
  });
});

describe("headed Chrome", () => {
  /** Opens a page in the bot's browser through its browser endpoint, which launches the engine. */
  async function launchBrowser(h: HandoffHost, botId: string) {
    const s = defined(h.server.browser.lease(botId).servers[0], "browser server");
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: { headers: { Authorization: `Bearer ${s.token}` } },
      }),
    );
    await client.callTool({ name: "browser_open", arguments: { url: "https://a.test" } });
  }
  const launches = (h: HandoffHost) => h.engineCalls().filter((c) => c.argv.includes("open"));

  test("remote mode launches Chrome headless although the bot's stored setting is headed", async () => {
    const h = await start(REMOTE);
    const bot = h.createBot("Ada");
    setBrowserEnabled(h.dataRoot, bot, true);
    setBrowserHeaded(h.dataRoot, bot, true);
    await launchBrowser(h, bot);
    expect(launches(h)).toHaveLength(1);
    expect(launches(h).some((c) => c.argv.includes("--headed"))).toBe(false);
  });

  test("local mode launches headed when the bot's setting is on", async () => {
    const h = await start();
    const bot = h.createBot("Ada");
    setBrowserEnabled(h.dataRoot, bot, true);
    setBrowserHeaded(h.dataRoot, bot, true);
    await launchBrowser(h, bot);
    expect(launches(h)).toHaveLength(1);
    expect(launches(h).every((c) => c.argv.includes("--headed"))).toBe(true);
  });

  test("remote mode refuses to turn the setting on, but lets a stored one be turned off", async () => {
    const h = await start(REMOTE);
    const bot = h.createBot("Ada");
    setBrowserHeaded(h.dataRoot, bot, true);

    const on = await h.ui("/api/bots/browser/headed", { botId: bot, headed: true });
    expect(on.status).toBe(409);
    expect(await on.text()).toContain("headed");
    expect(getBot(h.dataRoot, bot)?.browser.headed).toBe(true);

    expect((await h.ui("/api/bots/browser/headed", { botId: bot, headed: false })).status).toBe(
      200,
    );
    expect(getBot(h.dataRoot, bot)?.browser.headed).toBe(false);
    expect((await h.ui("/api/bots/browser/headed", { botId: "nope", headed: true })).status).toBe(
      404,
    );
  });

  test("local mode stores the setting", async () => {
    const h = await start();
    const bot = h.createBot("Ada");
    expect((await h.ui("/api/bots/browser/headed", { botId: bot, headed: true })).status).toBe(200);
    expect(getBot(h.dataRoot, bot)?.browser.headed).toBe(true);
  });
});
