import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, isIP, type AddressInfo, type Socket } from "node:net";

/** Resolves a hostname to every address it has. */
type Resolve = (host: string) => Promise<string[]>;
/** Opens a connection to an already-checked address. */
type Dial = (address: string, port: number) => Socket;

export interface EgressProxyOptions {
  resolve?: Resolve;
  dial?: Dial;
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, valid after `start`. */
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Hosts the proxy refused since `sinceMs` (epoch ms), oldest first. */
  blockedSince(sinceMs: number): string[];
}

const defaultResolve: Resolve = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);
const defaultDial: Dial = (address, port) => connect({ host: address, port });

type V4 = [number, number, number, number];
type V6 = [number, number, number, number, number, number, number, number];

function parseV4(s: string): V4 | undefined {
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  const [a = NaN, b = NaN, c = NaN, d = NaN] = parts.map((p) =>
    /^\d{1,3}$/.test(p) ? Number(p) : NaN,
  );
  const n: V4 = [a, b, c, d];
  return n.every((x) => x <= 255) ? n : undefined;
}

/** Eight 16-bit groups of an IPv6 address, or undefined when it is not valid IPv6. */
function parseV6(raw: string): V6 | undefined {
  let s = raw.split("%")[0] ?? "";
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (dotted) {
    const v4 = parseV4(dotted);
    if (!v4) return undefined;
    s =
      s.slice(0, -dotted.length) +
      ((v4[0] << 8) | v4[1]).toString(16) +
      ":" +
      ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const n = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (n.length !== 8 || n.some((x) => Number.isNaN(x))) return undefined;
  const [g0 = NaN, g1 = NaN, g2 = NaN, g3 = NaN, g4 = NaN, g5 = NaN, g6 = NaN, g7 = NaN] = n;
  return [g0, g1, g2, g3, g4, g5, g6, g7];
}

const blockedV4 = ([a, b]: V4) => a === 127 || a === 0 || (a === 169 && b === 254);

/** True for loopback, link-local (incl. cloud metadata), unspecified and 0.0.0.0/8; private LAN and public addresses pass. Unparseable input is blocked. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) return blockedV4(parseV4(bare)!);
  const g = parseV6(bare);
  if (!g) return true;
  const embedded: V4 = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  const first5Zero = g.slice(0, 5).every((x) => x === 0);
  if (first5Zero && g[5] === 0xffff) return blockedV4(embedded); // ::ffff:a.b.c.d
  if (first5Zero && g[5] === 0) return true; // ::, ::1 and IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return blockedV4(embedded); // NAT64
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g[7] === 0x254) return true; // AWS metadata over IPv6
  return false;
}

const HOP_HEADERS = [
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
];

export function createEgressProxy(o: EgressProxyOptions = {}): EgressProxy {
  const resolve = o.resolve ?? defaultResolve;
  const dial = o.dial ?? defaultDial;
  const blocks: { at: number; host: string }[] = [];
  const sockets = new Set<Socket>();
  let url = "";

  /** The one address to connect to, checked here and used as-is so DNS cannot change between check and connect. */
  async function allowedAddress(host: string): Promise<string | undefined> {
    const bare = host.replace(/^\[|\]$/g, "");
    const addresses = isIP(bare) ? [bare] : await resolve(bare).catch(() => []);
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      if (addresses.length > 0) blocks.push({ at: Date.now(), host: bare });
      return undefined;
    }
    return addresses[0];
  }

  async function forward(req: IncomingMessage, res: ServerResponse) {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
      if (target.protocol !== "http:") throw new Error("not http");
    } catch {
      return void res.writeHead(400).end();
    }
    const address = await allowedAddress(target.hostname);
    if (!address)
      return void res
        .writeHead(403, { "content-type": "text/plain" })
        .end(`Blocked by claudebot: ${target.hostname} is not reachable from the bot's browser`);
    const headers: OutgoingHttpHeaders = { ...req.headers, host: target.host };
    for (const h of HOP_HEADERS) delete headers[h];
    const port = Number(target.port || 80);
    const upstream = httpRequest(
      {
        method: req.method,
        path: target.pathname + target.search,
        headers,
        createConnection: () => dial(address, port),
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  async function tunnel(req: IncomingMessage, client: Socket, head: Buffer) {
    client.on("error", () => client.destroy());
    const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(req.url ?? "");
    if (!m) return void client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    const address = await allowedAddress(m[1] ?? m[2] ?? "");
    if (!address) return void client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const upstream = dial(address, Number(m[3]));
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () =>
      client.writable ? client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n") : client.destroy(),
    );
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }

  const server: Server = createServer((req, res) => void forward(req, res));
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    void tunnel(req, client, head);
  });

  return {
    get url() {
      return url;
    },
    async start() {
      const listening = Promise.withResolvers<void>();
      server.once("error", listening.reject);
      server.listen(0, "127.0.0.1", listening.resolve);
      await listening.promise;
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    async stop() {
      for (const s of sockets) s.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
    blockedSince: (sinceMs) => [
      ...new Set(blocks.filter((b) => b.at >= sinceMs).map((b) => b.host)),
    ],
  };
}
