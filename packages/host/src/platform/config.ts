import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { parseArgs } from "node:util";

/** Local: the host runs on the user's machine. Remote: the host runs on a server and users reach it over the network. */
export type HostMode = "local" | "remote";

/** Every deployment choice, read once at startup by `parseHostConfig`; nothing downstream reads the environment for these. */
export interface HostConfig {
  mode: HostMode;
  /** The one directory that holds all host state: database, bot directories, plugins and skills, user memory, and the managed Claude CLI and engine. Absolute. */
  dataRoot: string;
  /** Where the client-facing server listens; always loopback. Port 0 picks a free one. */
  bind: { address: string; port: number };
  /** The origin users and OAuth providers reach; the loopback URL of the bound port when unset. */
  publicUrl: string | undefined;
  /** Watch herdr for updates from other agents. */
  herdr: boolean;
  /** Serve the web UI through Vite (the dev script sets it). */
  vite: boolean;
}

/** The startup flags or environment variables are wrong; the message says which and why. */
export class InvalidConfig extends Error {}

/** Flags override environment variables, which override the defaults. */
const FLAGS = {
  mode: { type: "string" },
  "data-root": { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  "public-url": { type: "string" },
  herdr: { type: "boolean" },
  vite: { type: "boolean" },
} as const;

const MODES: readonly string[] = ["local", "remote"] satisfies HostMode[];

/** Both modes bind loopback on a free port unless told otherwise; the remote mode spec sets its own defaults. */
const DEFAULT_BIND = { address: "127.0.0.1", port: 0 };

/** What the default data root depends on; tests pass their own. */
export interface HostSystem {
  platform: NodeJS.Platform;
  home: string;
}

/** The OS application-data directory for claudebot: `~/Library/Application Support`, `%APPDATA%`, or `$XDG_DATA_HOME` (`~/.local/share`). */
function defaultDataRoot(
  env: Record<string, string | undefined>,
  { platform, home }: HostSystem,
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "claudebot");
  if (platform === "win32")
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "claudebot");
  const xdg = env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "claudebot");
}

function parseDataRoot(raw: string): string {
  if (!isAbsolute(raw))
    throw new InvalidConfig(`invalid data root "${raw}": expected an absolute path`);
  return normalize(raw);
}

const bare = (address: string) =>
  address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;

function isLoopback(address: string): boolean {
  const a = bare(address);
  return a === "localhost" || a === "::1" || (isIPv4(a) && a.startsWith("127."));
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535)
    throw new InvalidConfig(`invalid port "${raw}": expected an integer from 0 to 65535`);
  return port;
}

function parsePublicUrl(raw: string): string {
  const shown = raw.replace(/^.*@/, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new InvalidConfig(
      `invalid public URL "${shown}": expected an origin such as https://claudebot.example.com`,
    );
  }
  if (u.username || u.password)
    throw new InvalidConfig(`invalid public URL "${shown}": credentials are not allowed`);
  if (
    (u.protocol !== "http:" && u.protocol !== "https:") ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  ) {
    throw new InvalidConfig(
      `invalid public URL "${shown}": expected an http(s) origin without path, query or fragment`,
    );
  }
  return u.origin;
}

function parseBool(name: string, raw: string): boolean {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new InvalidConfig(`invalid ${name} "${raw}": expected 1, true, 0 or false`);
}

function parseFlags(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: FLAGS, allowPositionals: true });
  } catch (e) {
    throw new InvalidConfig((e as Error).message);
  }
}

/**
 * Reads the host's configuration from command-line flags (`--mode`, `--data-root`, `--host`, `--port`, `--public-url`, `--herdr`, `--vite`)
 * and `CLAUDEBOT_MODE|DATA_ROOT|HOST|PORT|PUBLIC_URL|HERDR|VITE`. `positionals` are the arguments that are not flags.
 * Without a data root the OS application-data directory is used.
 */
export function parseHostConfig(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  system: HostSystem = { platform: process.platform, home: homedir() },
): { config: HostConfig; positionals: string[] } {
  const { values, positionals } = parseFlags(argv);
  const get = (key: string) => (env[key] === "" ? undefined : env[key]);

  const mode = values.mode ?? get("CLAUDEBOT_MODE") ?? "local";
  if (!MODES.includes(mode))
    throw new InvalidConfig(`invalid mode "${mode}": expected local or remote`);
  const rawDataRoot = values["data-root"] ?? get("CLAUDEBOT_DATA_ROOT");
  const address = values.host ?? get("CLAUDEBOT_HOST") ?? DEFAULT_BIND.address;
  if (!isLoopback(address)) {
    throw new InvalidConfig(
      `refusing to bind ${address}: the host listens on loopback only (127.0.0.0/8, ::1 or localhost); reach it from other machines through the public URL`,
    );
  }
  const rawPort = values.port ?? get("CLAUDEBOT_PORT");
  const rawPublicUrl = values["public-url"] ?? get("CLAUDEBOT_PUBLIC_URL");
  const rawHerdr = get("CLAUDEBOT_HERDR");
  const rawVite = get("CLAUDEBOT_VITE");

  return {
    config: {
      mode: mode as HostMode,
      dataRoot:
        rawDataRoot === undefined ? defaultDataRoot(env, system) : parseDataRoot(rawDataRoot),
      bind: {
        address: bare(address),
        port: rawPort === undefined ? DEFAULT_BIND.port : parsePort(rawPort),
      },
      publicUrl: rawPublicUrl === undefined ? undefined : parsePublicUrl(rawPublicUrl),
      herdr:
        values.herdr ?? (rawHerdr === undefined ? false : parseBool("CLAUDEBOT_HERDR", rawHerdr)),
      vite: values.vite ?? (rawVite === undefined ? false : parseBool("CLAUDEBOT_VITE", rawVite)),
    },
    positionals,
  };
}

/** Where the running host is reachable, known once its socket is bound. */
export interface HostOrigin {
  /** `http://<bind address>:<port>`: how bots and the credential plugin on this machine reach the host. */
  readonly localUrl: string;
  /** The origin users and OAuth providers reach; the only source for the host's external origin. `X-Forwarded-*` headers are never consulted. */
  readonly publicUrl: string;
  /** Whether a request's Host header names this host on its bound address or as `localhost`; blocks DNS rebinding. */
  namesHost(header: string | undefined): boolean;
}

export function hostOrigin(config: HostConfig, port: number): HostOrigin {
  const { address } = config.bind;
  const localUrl = `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
  const bound = new URL(localUrl).host;
  return {
    localUrl,
    publicUrl: config.publicUrl ?? localUrl,
    namesHost: (header) => header === bound || header === `localhost:${port}`,
  };
}
