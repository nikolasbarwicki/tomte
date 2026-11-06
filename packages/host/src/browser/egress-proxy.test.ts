import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

import { createEgressProxy, isBlockedAddress, type EgressProxy } from "./egress-proxy.ts";

/** Hostnames the fake DNS knows; every allowed address is dialed to the local test origin, recording what was dialed. */
const dns: Record<string, string[]> = {
  "public.test": ["93.184.216.34"],
  "lan.test": ["192.168.1.20"],
  "rebind.test": ["127.0.0.1"],
  "mixed.test": ["93.184.216.34", "10.0.0.1", "127.0.0.1"],
};
const dialed: string[] = [];
let origin: Server;
let originPort: number;
let proxy: EgressProxy;

beforeAll(async () => {
  origin = createServer((req, res) => {
    if (req.url === "/redirect-to-loopback")
      return void res.writeHead(302, { location: "http://127.0.0.1:1/" }).end();
    if (req.url === "/redirect-to-metadata")
      return void res
        .writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" })
        .end();
    res.end(`origin saw host ${req.headers.host}`);
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as AddressInfo).port;
  proxy = createEgressProxy({
    resolve: async (host) => dns[host] ?? Promise.reject(new Error("NXDOMAIN")),
    dial: (address) => {
      dialed.push(address);
      return connect({ host: "127.0.0.1", port: originPort });
    },
  });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  origin.close();
});

const proxyPort = () => Number(new URL(proxy.url).port);

/** A plain HTTP request through the proxy, the way a browser sends it. */
function viaProxy(url: string): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    request(
      {
        host: "127.0.0.1",
        port: proxyPort(),
        method: "GET",
        path: url,
        headers: { host: new URL(url).host },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body, location: res.headers.location }),
        );
      },
    )
      .on("error", reject)
      .end();
  });
}

/** Follows redirects through the proxy like a browser does, each hop a fresh proxied request. */
async function follow(url: string) {
  let r = await viaProxy(url);
  while (r.status === 302) r = await viaProxy(r.location!);
  return r;
}

/** A `blockedSince` marker strictly after every block already recorded: blocks are stamped in whole ms, so wait out the current one. */
function freshSince(): number {
  const now = Date.now();
  let next = now;
  while (next === now) next = Date.now();
  return next;
}

/** CONNECT through the proxy; resolves with the status line the proxy sent. */
function tunnel(target: string): Promise<{ status: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: proxyPort() }, () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    socket.once("data", (d) =>
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(d.toString())![1]), socket }),
    );
    socket.on("error", reject);
  });
}

describe("addresses", () => {
  test.each([
    "127.0.0.1",
    "127.8.9.10",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "169.254.169.254",
    "169.254.0.1",
    "fe80::1",
    "febf::1",
    "0.0.0.0",
    "0.1.2.3",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
    "fd00:ec2::254",
    "not-an-ip",
  ])("%s is blocked", (a) => {
    expect(isBlockedAddress(a)).toBe(true);
  });

  test.each([
    "93.184.216.34",
    "192.168.1.20",
    "10.0.0.1",
    "172.16.5.5",
    "2606:2800:220:1:248:1893:25c8:1946",
    "fd12:3456::1",
    "::ffff:192.168.1.1",
    "fec0::1",
  ])("%s is allowed", (a) => {
    expect(isBlockedAddress(a)).toBe(false);
  });
});

describe("http through the proxy", () => {
  test("a public destination is reached at the checked address", async () => {
    dialed.length = 0;
    const r = await viaProxy("http://public.test/page");
    expect(r.status).toBe(200);
    expect(r.body).toBe("origin saw host public.test");
    expect(dialed).toEqual(["93.184.216.34"]);
  });

  test("a private LAN destination is reached", async () => {
    dialed.length = 0;
    expect((await viaProxy("http://lan.test/")).status).toBe(200);
    expect(dialed).toEqual(["192.168.1.20"]);
  });

  test("direct loopback is blocked on any port, v4 and v6, and nothing is dialed", async () => {
    dialed.length = 0;
    for (const u of [
      `http://127.0.0.1:${originPort}/`,
      "http://127.0.0.1:1/",
      "http://localhost:80/",
      "http://[::1]:80/",
      "http://[::ffff:127.0.0.1]:80/",
    ]) {
      expect((await viaProxy(u)).status).toBe(403);
    }
    expect(dialed).toEqual([]);
  });

  test("a hostname resolving to loopback is blocked", async () => {
    dialed.length = 0;
    const r = await viaProxy("http://rebind.test/");
    expect(r.status).toBe(403);
    expect(r.body).toContain("Blocked by claudebot");
    expect(dialed).toEqual([]);
  });

  test("a hostname with any blocked address among its answers is blocked", async () => {
    expect((await viaProxy("http://mixed.test/")).status).toBe(403);
  });

  test("link-local and metadata addresses are blocked", async () => {
    expect((await viaProxy("http://169.254.169.254/latest/meta-data/")).status).toBe(403);
    expect((await viaProxy("http://[fe80::1]/")).status).toBe(403);
    expect((await viaProxy("http://0.0.0.0/")).status).toBe(403);
  });

  test("a redirect from an allowed host to a blocked address is blocked at the next hop", async () => {
    expect((await viaProxy("http://public.test/redirect-to-loopback")).status).toBe(302);
    expect((await follow("http://public.test/redirect-to-loopback")).status).toBe(403);
    expect((await follow("http://public.test/redirect-to-metadata")).status).toBe(403);
  });

  test("blocked hosts are reported since a given time", async () => {
    const since = freshSince();
    await viaProxy("http://rebind.test/");
    expect(proxy.blockedSince(since)).toEqual(["rebind.test"]);
    expect(proxy.blockedSince(Date.now() + 1000)).toEqual([]);
  });

  test("an unresolvable name is refused but not recorded as a block", async () => {
    const since = freshSince();
    expect((await viaProxy("http://nxdomain.test/")).status).toBe(403);
    expect(proxy.blockedSince(since)).toEqual([]);
  });
});

describe("CONNECT through the proxy", () => {
  test("a public destination gets a tunnel to the checked address", async () => {
    dialed.length = 0;
    const { status, socket } = await tunnel("public.test:443");
    expect(status).toBe(200);
    expect(dialed).toEqual(["93.184.216.34"]);
    socket.destroy();
  });

  test("loopback, a rebinding name, link-local and v6 loopback are refused", async () => {
    dialed.length = 0;
    for (const t of [
      `127.0.0.1:${originPort}`,
      "rebind.test:443",
      "169.254.169.254:80",
      "[::1]:443",
      "[::ffff:127.0.0.1]:443",
    ]) {
      const { status, socket } = await tunnel(t);
      expect(status).toBe(403);
      socket.destroy();
    }
    expect(dialed).toEqual([]);
  });
});
