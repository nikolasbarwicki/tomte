import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PairingResponse } from "@tomte/contract/api";

import { listBots } from "../bots/index.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const HOST_CLI = join(import.meta.dir, "../host.ts");

const hosts: HandoffHost[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

const start = async (flags: string[] = []) => {
  const host = await startHandoffHost(flags);
  hosts.push(host);
  return host;
};

/** A request with a Host header of the caller's choosing, which `fetch` does not allow. */
function withHost(
  host: HandoffHost,
  path: string,
  headers: Record<string, string>,
): Promise<number | undefined> {
  const status = Promise.withResolvers<number | undefined>();
  const req = request(`${host.clientUrl}${path}`, { headers }, (res) => {
    status.resolve(res.statusCode);
    res.destroy();
  });
  req.on("error", status.reject);
  req.end();
  return status.promise;
}

const exchange = (host: HandoffHost, body: object, headers: Record<string, string> = {}) =>
  fetch(`${host.clientUrl}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: host.clientUrl, ...headers },
    body: JSON.stringify(body),
  });

describe("the two requests from the UI API auth issue", () => {
  test("a cross-origin text/plain POST cannot create a bot", async () => {
    const host = await start();
    const res = await fetch(`${host.clientUrl}/api/bots/new`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://evil.example",
        ...host.authHeaders,
      },
      body: JSON.stringify({ name: "evil" }),
    });
    expect(res.status).toBe(403);
    expect(listBots(host.dataRoot)).toEqual([]);
  });

  test("a request with a rebinding Host cannot read the event stream", async () => {
    const host = await start();
    const rebind = { host: `rebind.example:${new URL(host.clientUrl).port}` };
    expect(await withHost(host, "/api/events", { ...rebind, ...host.authHeaders })).toBe(403);
    expect(await withHost(host, "/api/events", rebind)).toBe(403);
  });
});

describe("the device token", () => {
  test("a request without one gets 401, and the same request with a bearer token succeeds", async () => {
    const host = await start();
    const info = (headers: Record<string, string> = {}) =>
      fetch(`${host.clientUrl}/api/info`, { headers });
    expect((await info()).status).toBe(401);
    expect((await info({ authorization: "Bearer not-a-token" })).status).toBe(401);
    expect((await info(host.authHeaders)).status).toBe(200);
  });

  test("the same holds for a write, which needs the host's own Origin and JSON as well", async () => {
    const host = await start();
    const post = (headers: Record<string, string>) =>
      fetch(`${host.clientUrl}/api/integrations/list`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: host.clientUrl, ...headers },
        body: "{}",
      });
    expect((await post({})).status).toBe(401);
    expect((await post(host.authHeaders)).status).toBe(200);
  });

  test("the session cookie is accepted as the same credential", async () => {
    const host = await start();
    const info = (cookie: string) => fetch(`${host.clientUrl}/api/info`, { headers: { cookie } });
    const cookie = `tomte_session=${host.deviceToken}`;
    expect((await info(cookie)).status).toBe(200);
    expect((await info(`other=1; ${cookie}; more=2`)).status).toBe(200);
    expect((await info("tomte_session=not-a-token")).status).toBe(401);
  });

  test("the static app, the login page and the OAuth callback load without one", async () => {
    const host = await start();
    expect((await fetch(`${host.clientUrl}/`)).status).toBe(404);
    expect((await fetch(`${host.clientUrl}/login`)).status).toBe(404);
    expect((await fetch(`${host.clientUrl}/oauth/callback?state=x&code=y`)).status).toBe(400);
  });

  test("a token still works after the host restarts", async () => {
    const host = await start();
    await host.restart();
    expect((await fetch(`${host.clientUrl}/api/info`, { headers: host.authHeaders })).status).toBe(
      200,
    );
  });
});

describe("pairing", () => {
  const hostPair = async (dataRoot: string) => {
    const run = Bun.spawn(["bun", HOST_CLI, "pair", "--data-root", dataRoot], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    expect(code).toBe(0);
    return out.trim();
  };

  test("a code from `host pair`, run next to a running host, is exchanged for a working device token", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "pair-"));
    scratch.push(dataRoot);
    const host = await start(["--data-root", dataRoot]);

    const code = await hostPair(dataRoot);
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);

    const res = await exchange(host, { code, name: "laptop" });
    expect(res.status).toBe(200);
    const { token } = PairingResponse.parse(await res.json());
    expect(token.length).toBeGreaterThanOrEqual(43);

    const authed = (t: string) =>
      fetch(`${host.clientUrl}/api/info`, { headers: { authorization: `Bearer ${t}` } });
    expect((await authed(token)).status).toBe(200);
  });

  test("a browser caller gets the session cookie, which is HttpOnly and SameSite=Strict, and works", async () => {
    const host = await start();
    const code = host.server.devices.createPairingCode();
    const res = await exchange(host, { code, name: "browser" });
    const { token } = PairingResponse.parse(await res.json());

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`tomte_session=${token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");

    const pair = cookie.split(";")[0] ?? "";
    expect((await fetch(`${host.clientUrl}/api/info`, { headers: { cookie: pair } })).status).toBe(
      200,
    );
  });

  test("the cookie is Secure when the public URL is HTTPS", async () => {
    const host = await start(["--public-url", "https://tomte.example.com"]);
    const code = host.server.devices.createPairingCode();
    const res = await exchange(host, { code, name: "browser" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  test("the public URL's origin and host are accepted, an unrelated one is not", async () => {
    const host = await start(["--public-url", "https://tomte.example.com"]);
    const publicOrigin = { origin: "https://tomte.example.com", ...host.authHeaders };
    const post = (headers: Record<string, string>) =>
      fetch(`${host.clientUrl}/api/integrations/list`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
    expect((await post(publicOrigin)).status).toBe(200);
    expect((await post({ ...publicOrigin, origin: "https://tomte.example.org" })).status).toBe(403);
    expect(
      await withHost(host, "/api/info", { host: "tomte.example.com", ...host.authHeaders }),
    ).toBe(200);
    expect(
      await withHost(host, "/api/info", { host: "tomte.example.org", ...host.authHeaders }),
    ).toBe(403);
  });

  test("a code is accepted however a person types it", async () => {
    const host = await start();
    const code = host.server.devices.createPairingCode();
    const typed = code.replaceAll("-", " ").toLowerCase();
    expect((await exchange(host, { code: typed, name: "phone" })).status).toBe(200);
  });

  test("a wrong code is refused without a token or cookie, and a malformed request is a 400", async () => {
    const host = await start();
    const wrong = await exchange(host, { code: "AAAA-AAAA-AAAA", name: "laptop" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(await wrong.json())).not.toContain("AAAA");

    expect((await exchange(host, { name: "laptop" })).status).toBe(400);
    expect((await exchange(host, { code: "AAAA-AAAA-AAAA", name: "   " })).status).toBe(400);
    const notJson = await fetch(`${host.clientUrl}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: host.clientUrl },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);
  });

  test("the pairing exchange is still behind the boundary check", async () => {
    const host = await start();
    const code = host.server.devices.createPairingCode();
    expect(
      (await exchange(host, { code, name: "x" }, { origin: "https://evil.example" })).status,
    ).toBe(403);
    const plain = await fetch(`${host.clientUrl}/api/pair`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: host.clientUrl },
      body: JSON.stringify({ code, name: "x" }),
    });
    expect(plain.status).toBe(415);
  });

  const MINUTE = 60_000;
  const wrongGuess = (host: HandoffHost) =>
    exchange(host, { code: "AAAA-AAAA-AAAA", name: "guesser" });
  const guessWrong = async (host: HandoffHost, times: number) => {
    for (let i = 0; i < times; i++) expect((await wrongGuess(host)).status).toBe(401);
  };

  test("a code works once: a second exchange of it fails", async () => {
    const host = await start();
    const code = host.server.devices.createPairingCode();
    expect((await exchange(host, { code, name: "first" })).status).toBe(200);
    expect((await exchange(host, { code, name: "second" })).status).toBe(401);
  });

  test("of concurrent exchanges of one code, exactly one succeeds", async () => {
    const host = await start();
    const code = host.server.devices.createPairingCode();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => exchange(host, { code, name: `device ${i}` })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(7);
  });

  test("a code works until 10 minutes after it was created and not after", async () => {
    const host = await start();
    const early = host.server.devices.createPairingCode();
    const late = host.server.devices.createPairingCode();

    host.advanceClock(10 * MINUTE - 1);
    expect((await exchange(host, { code: early, name: "just in time" })).status).toBe(200);

    host.advanceClock(1);
    expect((await exchange(host, { code: late, name: "too late" })).status).toBe(401);
  });

  test("a code that expired stays refused even if it was never tried before", async () => {
    const host = await start();
    const code = host.server.devices.createPairingCode();
    host.advanceClock(11 * MINUTE);
    expect((await exchange(host, { code, name: "late" })).status).toBe(401);
    const fresh = host.server.devices.createPairingCode();
    expect((await exchange(host, { code: fresh, name: "on time" })).status).toBe(200);
  });

  test("after 10 failed attempts a code that was valid before is refused, and so is every other outstanding code", async () => {
    const host = await start();
    const first = host.server.devices.createPairingCode();
    const second = host.server.devices.createPairingCode();

    await guessWrong(host, 10);

    expect((await exchange(host, { code: first, name: "a" })).status).toBe(401);
    expect((await exchange(host, { code: second, name: "b" })).status).toBe(401);
    const next = host.server.devices.createPairingCode();
    expect((await exchange(host, { code: next, name: "c" })).status).toBe(200);
  });

  test("9 failed attempts do not lock, and a success does not reset the count", async () => {
    const host = await start();
    const first = host.server.devices.createPairingCode();
    const second = host.server.devices.createPairingCode();

    await guessWrong(host, 9);
    expect((await exchange(host, { code: first, name: "a" })).status).toBe(200);
    await guessWrong(host, 1);
    expect((await exchange(host, { code: second, name: "b" })).status).toBe(401);
  });

  test("creating a code restarts the count, including a code from `host pair` in another process", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "pair-"));
    scratch.push(dataRoot);
    const host = await start(["--data-root", dataRoot]);

    await guessWrong(host, 9);
    const code = await hostPair(dataRoot);
    await guessWrong(host, 9);
    expect((await exchange(host, { code, name: "after reset" })).status).toBe(200);
  });

  test("the count survives a host restart", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "pair-"));
    scratch.push(dataRoot);
    const host = await start(["--data-root", dataRoot]);
    const code = host.server.devices.createPairingCode();

    await guessWrong(host, 9);
    await host.restart();
    await guessWrong(host, 1);
    expect((await exchange(host, { code, name: "locked" })).status).toBe(401);
  });
});
