import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { parseArgs } from "node:util";

/** Local: the host runs on the user's machine. Remote: the host runs on a server and users reach it over the network. */
type HostMode = "local" | "remote";

/** Where the host keeps its secrets: the OS keychain, or an encrypted file in the data root whose 32-byte key is read from `keyFile` (an absolute path; the key itself is never configuration). */
type SecretsConfig = { backend: "keychain" } | { backend: "file"; keyFile: string };

/** Every deployment choice, read once at startup by `parseHostConfig`; nothing downstream reads the environment for these. */
export interface HostConfig {
  mode: HostMode;
  /** The one directory that holds all host state: database, bot directories, plugins and skills, user memory, and the managed Claude CLI and engine. Absolute. */
  dataRoot: string;
  /** Where the client-facing server listens. A non-loopback address parses only when the public URL is HTTPS or `allowPlainHttp` is set. Port 0 picks a free one. */
  bind: { address: string; port: number };
  /** The origin users and OAuth providers reach; the loopback URL of the bound port when unset. */
  publicUrl: string | undefined;
  /** Serve the web UI through Vite (the dev script sets it). */
  vite: boolean;
  /** Ask the user before a bot runs a tool instead of approving everything; `TOMTE_ASK_APPROVAL`. */
  askApproval: boolean;
  /** Allow a non-loopback bind while the public URL is not HTTPS, for private networks such as Tailscale; `--allow-plain-http`, `TOMTE_ALLOW_PLAIN_HTTP`. */
  allowPlainHttp: boolean;
  /** The secrets backend: keychain in local mode, file in remote mode; `--secrets`, `--secrets-key-file`, `TOMTE_SECRETS`, `TOMTE_SECRETS_KEY_FILE`. */
  secrets: SecretsConfig;
  /** The operator's relay configuration file (ADR-0008): absolute; `relay.json` in the data root unless `--relay-config` or `TOMTE_RELAY_CONFIG` names another. The file need not exist: without it no answer is relayed. */
  relayConfig: string;
  /** Whether a bot may run headed Chrome; local mode only. */
  headedBrowser: boolean;
  /** Whether the host can reveal a folder in the user's file manager; local mode only. */
  reveal: boolean;
  /** Whether every bot's shell runs under isolation, not only bots with the browser enabled; remote mode only. */
  isolateAllBots: boolean;
  /** Run as the desktop app's sidecar: read the launch token from stdin, print one JSON ready line to stdout, and shut down when stdin ends; local mode only; `--sidecar`. */
  sidecar: boolean;
  /** Days without any action of the owner (a request from a paired device except the event stream, or a linked channel action) after which every active routine is paused; 0 is off. `--pause-after-absence-days`, `TOMTE_PAUSE_AFTER_ABSENCE_DAYS`. */
  pauseAfterAbsenceDays: number;
  /** The most bytes one uploaded file may hold, per file; a larger upload is refused with 413. `--max-upload-mib`, `TOMTE_MAX_UPLOAD_MIB` (whole MiB, at least 1); 1 GiB by default. */
  maxUploadBytes: number;
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
  vite: { type: "boolean" },
  "allow-plain-http": { type: "boolean" },
  sidecar: { type: "boolean" },
  secrets: { type: "string" },
  "secrets-key-file": { type: "string" },
  "relay-config": { type: "string" },
  "pause-after-absence-days": { type: "string" },
  "max-upload-mib": { type: "string" },
} as const;

const MODES: readonly string[] = ["local", "remote"] satisfies HostMode[];

/** Both modes bind loopback on a free port unless told otherwise; a deployment sets its own address and port. */
const DEFAULT_BIND = { address: "127.0.0.1", port: 0 };

const BACKENDS: readonly string[] = ["keychain", "file"] satisfies SecretsConfig["backend"][];

/** The backend defaults to the mode's; `file` needs an absolute key file path, and `keychain` takes none, so a stray path is never silently ignored. */
function parseSecrets(
  mode: HostMode,
  rawBackend: string | undefined,
  rawKeyFile: string | undefined,
): SecretsConfig {
  const backend = rawBackend ?? (mode === "remote" ? "file" : "keychain");
  if (!BACKENDS.includes(backend))
    throw new InvalidConfig(`invalid secrets backend "${backend}": expected keychain or file`);
  if (backend === "keychain") {
    if (rawKeyFile !== undefined)
      throw new InvalidConfig(
        `a secrets key file only applies to the file backend, but the secrets backend is keychain; drop --secrets-key-file or use --secrets file`,
      );
    return { backend };
  }
  if (rawKeyFile === undefined)
    throw new InvalidConfig(
      `the file secrets backend needs a key file of 32 raw bytes: pass --secrets-key-file <absolute path> (TOMTE_SECRETS_KEY_FILE), or use --secrets keychain`,
    );
  if (!isAbsolute(rawKeyFile))
    throw new InvalidConfig(`invalid secrets key file "${rawKeyFile}": expected an absolute path`);
  return { backend: "file", keyFile: normalize(rawKeyFile) };
}

/** The agent listener's address; it never leaves this machine. */
export const AGENT_ADDRESS = "127.0.0.1";

/** What the default data root depends on; tests pass their own. */
export interface HostSystem {
  platform: NodeJS.Platform;
  home: string;
}

/** The OS application-data directory for tomte: `~/Library/Application Support`, `%APPDATA%`, or `$XDG_DATA_HOME` (`~/.local/share`). */
function defaultDataRoot(
  env: Record<string, string | undefined>,
  { platform, home }: HostSystem,
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "tomte");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "tomte");
  const xdg = env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "tomte");
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
      `invalid public URL "${shown}": expected an origin such as https://tomte.example.com`,
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

function parseAbsenceDays(raw: string): number {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new InvalidConfig(
      `invalid pause-after-absence days "${raw}": expected a non-negative integer (0 turns it off)`,
    );
  return Number(raw);
}

/** One MiB is 2^20 bytes. */
const MIB = 2 ** 20;

/** The per-file upload cap when nothing sets one: 1 GiB. */
const DEFAULT_MAX_UPLOAD_MIB = 1024;

function parseMaxUploadMib(raw: string): number {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw) * MIB) || Number(raw) < 1)
    throw new InvalidConfig(
      `invalid max upload size "${raw}": expected a whole number of MiB, at least 1`,
    );
  return Number(raw);
}

/** Remote mode is Linux-only (ADR-0006): the message says why for the platform this host runs on and where remote mode can run instead. */
function remoteRefusal(platform: NodeJS.Platform): string {
  const why =
    platform === "darwin"
      ? "on macOS the Claude sign-in sits in the login keychain, where the bot sandbox cannot keep bots away from it"
      : `this host runs on ${platform}, and remote mode is neither built nor tested there`;
  return `remote mode is supported on Linux only: ${why}; use local mode${platform === "darwin" ? " on a Mac" : ""} and run remote mode on a Linux server`;
}

function parseFlags(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: FLAGS, allowPositionals: true });
  } catch (e) {
    throw new InvalidConfig((e as Error).message);
  }
}

/**
 * Reads the host's configuration from command-line flags (`--mode`, `--data-root`, `--host`, `--port`, `--public-url`, `--allow-plain-http`,
 * `--secrets`, `--secrets-key-file`, `--relay-config`, `--pause-after-absence-days`, `--max-upload-mib`, `--vite`, `--sidecar`) and
 * `TOMTE_MODE|DATA_ROOT|HOST|PORT|PUBLIC_URL|ALLOW_PLAIN_HTTP|SECRETS|SECRETS_KEY_FILE|RELAY_CONFIG|PAUSE_AFTER_ABSENCE_DAYS|MAX_UPLOAD_MIB|VITE|ASK_APPROVAL`. `positionals` are the arguments that are not flags.
 * Without a data root the OS application-data directory is used. Remote mode parses on Linux only (ADR-0006).
 */
export function parseHostConfig(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  system: HostSystem = { platform: process.platform, home: homedir() },
): { config: HostConfig; positionals: string[] } {
  const { values, positionals } = parseFlags(argv);
  const get = (key: string) => (env[key] === "" ? undefined : env[key]);

  const mode = values.mode ?? get("TOMTE_MODE") ?? "local";
  if (!MODES.includes(mode))
    throw new InvalidConfig(`invalid mode "${mode}": expected local or remote`);
  if (mode === "remote" && system.platform !== "linux")
    throw new InvalidConfig(remoteRefusal(system.platform));
  if (mode === "remote" && values.sidecar)
    throw new InvalidConfig(
      "--sidecar is for the desktop app's local host and cannot run in remote mode; drop --sidecar or use --mode local",
    );
  const rawDataRoot = values["data-root"] ?? get("TOMTE_DATA_ROOT");
  const address = values.host ?? get("TOMTE_HOST") ?? DEFAULT_BIND.address;
  const rawPublicUrl = values["public-url"] ?? get("TOMTE_PUBLIC_URL");
  const publicUrl = rawPublicUrl === undefined ? undefined : parsePublicUrl(rawPublicUrl);
  const rawAllowPlainHttp = get("TOMTE_ALLOW_PLAIN_HTTP");
  const allowPlainHttp =
    values["allow-plain-http"] ??
    (rawAllowPlainHttp === undefined
      ? false
      : parseBool("TOMTE_ALLOW_PLAIN_HTTP", rawAllowPlainHttp));
  if (!isLoopback(address) && !allowPlainHttp && !publicUrl?.startsWith("https:")) {
    throw new InvalidConfig(
      `refusing to bind ${address}: the public URL is ${publicUrl ?? "not set"}, so users would reach the host over plain HTTP; set --public-url to an https:// origin (a TLS proxy in front), or pass --allow-plain-http (TOMTE_ALLOW_PLAIN_HTTP=1) on a private network such as Tailscale`,
    );
  }
  const rawPort = values.port ?? get("TOMTE_PORT");
  const rawVite = get("TOMTE_VITE");
  const rawAskApproval = get("TOMTE_ASK_APPROVAL");
  const rawAbsenceDays =
    values["pause-after-absence-days"] ?? get("TOMTE_PAUSE_AFTER_ABSENCE_DAYS");
  const rawMaxUploadMib = values["max-upload-mib"] ?? get("TOMTE_MAX_UPLOAD_MIB");
  const rawRelayConfig = values["relay-config"] ?? get("TOMTE_RELAY_CONFIG");
  if (rawRelayConfig !== undefined && !isAbsolute(rawRelayConfig))
    throw new InvalidConfig(`invalid relay config "${rawRelayConfig}": expected an absolute path`);
  const dataRoot =
    rawDataRoot === undefined ? defaultDataRoot(env, system) : parseDataRoot(rawDataRoot);

  return {
    config: {
      mode: mode as HostMode,
      dataRoot,
      bind: {
        address: bare(address),
        port: rawPort === undefined ? DEFAULT_BIND.port : parsePort(rawPort),
      },
      publicUrl,
      allowPlainHttp,
      secrets: parseSecrets(
        mode as HostMode,
        values.secrets ?? get("TOMTE_SECRETS"),
        values["secrets-key-file"] ?? get("TOMTE_SECRETS_KEY_FILE"),
      ),
      relayConfig:
        rawRelayConfig === undefined ? join(dataRoot, "relay.json") : normalize(rawRelayConfig),
      headedBrowser: mode === "local",
      reveal: mode === "local",
      isolateAllBots: mode === "remote",
      sidecar: values.sidecar ?? false,
      pauseAfterAbsenceDays: rawAbsenceDays === undefined ? 0 : parseAbsenceDays(rawAbsenceDays),
      maxUploadBytes:
        (rawMaxUploadMib === undefined
          ? DEFAULT_MAX_UPLOAD_MIB
          : parseMaxUploadMib(rawMaxUploadMib)) * MIB,
      vite: values.vite ?? (rawVite === undefined ? false : parseBool("TOMTE_VITE", rawVite)),
      askApproval:
        rawAskApproval === undefined ? false : parseBool("TOMTE_ASK_APPROVAL", rawAskApproval),
    },
    positionals,
  };
}

/** Where one of the host's listeners is reachable, known once its socket is bound. */
export interface HostOrigin {
  /** `http://<bind address>:<port>`: how callers on this machine reach the listener. */
  readonly localUrl: string;
  /** The origin users and OAuth providers reach; the only source for the host's external origin. `X-Forwarded-*` headers are never consulted. The loopback URL for the agent listener. */
  readonly publicUrl: string;
  /** Whether a request's Host header names this listener on its bound address or as `localhost`, or names the public URL's host; blocks DNS rebinding. */
  namesHost(header: string | undefined): boolean;
  /** Whether a request's Origin header is the public URL's origin or this listener's own loopback origin. */
  namesOrigin(header: string | undefined): boolean;
}

function listenerOrigin(address: string, port: number, publicUrl: string | undefined): HostOrigin {
  const localUrl = `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
  const hosts = new Set([new URL(localUrl).host, `localhost:${port}`]);
  const origins = new Set([localUrl, `http://localhost:${port}`]);
  if (publicUrl !== undefined) {
    hosts.add(new URL(publicUrl).host);
    origins.add(publicUrl);
  }
  return {
    localUrl,
    publicUrl: publicUrl ?? localUrl,
    namesHost: (header) => header !== undefined && hosts.has(header),
    namesOrigin: (header) => header !== undefined && origins.has(header),
  };
}

/** The client listener: the address and port from `config.bind`, reached by users at the public URL. */
export function clientOrigin(config: HostConfig, port: number): HostOrigin {
  return listenerOrigin(config.bind.address, port, config.publicUrl);
}

/** The agent listener: always `127.0.0.1`, on a free port, reached only by bots on this machine. */
export function agentOrigin(port: number): HostOrigin {
  return listenerOrigin(AGENT_ADDRESS, port, undefined);
}
