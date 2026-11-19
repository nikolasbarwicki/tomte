import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  SdkPluginConfig,
} from "@anthropic-ai/claude-agent-sdk";
import {
  auth as mcpAuth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthStart } from "@tomte/contract/api";
import type {
  BuiltinService,
  CatalogInfo,
  Integration,
  IntegrationAuth,
  IntegrationTransport,
  OwnClient,
  ToolPolicy,
} from "@tomte/contract/events";
import { z } from "zod";

import { InvalidInput, NotFound } from "../platform/errors.ts";
import { secretName, type SecretStore } from "../platform/secrets.ts";
import {
  BUILTIN_LOCKED_TOOLS,
  builtinTools,
  createBuiltinServer,
  prepareBuiltinApproval,
} from "./builtin.ts";
import { CATALOG, type CatalogEntry } from "./catalog.ts";
import { GmailError } from "./gmail/client.ts";
import {
  GOOGLE_ENDPOINTS,
  GrantRevoked,
  authorizationUrl,
  exchangeCode,
  newPkce,
  refreshTokens,
  type GoogleEndpoints,
} from "./google-oauth.ts";
import { buildPlugin, gitClone, scanSkills, type GitClone } from "./skills.ts";
import * as store from "./store.ts";
import type { DiscoveredTool, IntegrationRecord } from "./store.ts";

export type { GoogleEndpoints, ToolPolicy };
export type ServerName = string & { readonly __brand: "ServerName" };
export type ToolDecision = "deny" | "ask" | "allow";

export type SessionIntegrations = {
  mcpServers: Record<ServerName, McpServerConfig>;
  /**
   * In-process servers of built-in integrations, by server name, a fresh set for every session. An instance cannot be serialised,
   * so these never go into the CLI's `--mcp-config` file: a session merges them into the SDK `query()` options' `mcpServers`.
   */
  builtinServers: Record<ServerName, McpSdkServerConfigWithInstance>;
  disallowedTools: string[];
  plugins: SdkPluginConfig[];
  /** Policy of an integration tool by its `mcp__<server>__<tool>` name; undefined when no integration owns it. */
  policyOf(toolName: string): ToolPolicy | undefined;
  /** Epoch ms after which this configuration must be rebuilt. */
  expiresAt?: number | undefined;
};

/** What a thread needs from the integrations module. */
export interface IntegrationsSource {
  /** `filesDir` is the bot's files folder, which a built-in integration's tools may save files in. */
  session(filesDir?: string): Promise<SessionIntegrations>;
  /** undefined: not an integration tool, so the caller's own rules apply. */
  decide(toolName: string): ToolDecision | undefined;
  /**
   * The input to show the owner for approval and then run: a built-in tool may add what the owner must see and the run must still
   * find true (a send of a draft gains the draft's content). `refused` is why the call cannot be offered. Any other tool: `input`.
   */
  prepareApproval(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ input: Record<string, unknown> } | { refused: string }>;
  /** True for a tool a built-in integration locks: it always asks, whatever its setting or the bot's always-allow rules say. */
  locked(toolName: string): boolean;
  /** Records what Claude Code reports about each server after a session opened. */
  reconcile(statuses: ServerStatus[]): void;
}

/** The part of Claude Code's per-server status the integrations module records. */
export type ServerStatus = {
  name: string;
  status: string;
  error?: string;
  tools?: {
    name: string;
    description?: string;
    annotations?: { readOnly?: boolean; destructive?: boolean };
  }[];
};

/** A name already taken; maps to HTTP 409. */
export class NameTaken extends Error {}

const NAME = /^[a-z][a-z0-9_]{0,31}$/;
const RESERVED = new Set(["host", "browser", "bots", "routines", "gmail"]);
const DISCOVERY_TIMEOUT_MS = 15_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;

/** The OAuth half of an integration's keychain entry: the registered client, the redirect URL it was registered with, and the current tokens. */
const OAuthSecret = z.object({
  client: z.union([OAuthClientInformationFullSchema, OAuthClientInformationSchema]).exactOptional(),
  /** Recorded when a client is registered dynamically; absent for a static client and for a client registered before it was recorded. */
  redirectUrl: z.string().exactOptional(),
  tokens: OAuthTokensSchema.exactOptional(),
  expiresAt: z.number().optional(),
});
type OAuthSecret = z.infer<typeof OAuthSecret>;
/** An integration's keychain entry, stored as JSON. */
const Secret = z.object({
  token: z.string().exactOptional(),
  env: z.record(z.string(), z.string()).exactOptional(),
  oauth: OAuthSecret.exactOptional(),
});
type Secret = z.infer<typeof Secret>;

/**
 * The redirect URLs a dynamically registered client is registered for. A client stored before the URL was recorded
 * falls back to the `redirect_uris` the server echoed in its client information; one with neither is unknown, so it
 * is treated as registered for no current URL and registers again on the next connect.
 */
const registeredRedirects = (o: OAuthSecret): string[] =>
  o.redirectUrl !== undefined
    ? [o.redirectUrl]
    : o.client && "redirect_uris" in o.client
      ? o.client.redirect_uris
      : [];

/** Google issues a refresh token only when asked for offline access, and re-issues one only on a fresh consent. */
export function withOfflineAccess(u: URL): URL {
  if (u.host !== "accounts.google.com") return u;
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u;
}

/** Holds one sign-in's state in memory; `persist` runs after every token save, and is absent while a sign-in is pending. */
class OAuthState implements OAuthClientProvider {
  authorizeUrl?: URL;
  private verifier = "";
  constructor(
    readonly redirectUrl: string,
    private readonly stateValue: string,
    readonly secret: OAuthSecret,
    private readonly now: () => number,
    private readonly persist?: (s: OAuthSecret) => Promise<void>,
  ) {}
  get clientMetadata() {
    return {
      client_name: "Tomte",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state = () => this.stateValue;
  clientInformation = () => this.secret.client;
  saveClientInformation(c: OAuthClientInformationMixed) {
    this.secret.client = c;
    this.secret.redirectUrl = this.redirectUrl;
  }
  tokens = () => this.secret.tokens;
  async saveTokens(t: OAuthTokens) {
    this.secret.tokens = t;
    this.secret.expiresAt =
      t.expires_in === undefined ? undefined : this.now() + t.expires_in * 1000;
    await this.persist?.(this.secret);
  }
  redirectToAuthorization(u: URL) {
    this.authorizeUrl = withOfflineAccess(u);
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier = () => this.verifier;
}

function parseServerName(raw: string): ServerName {
  if (!raw) throw new InvalidInput("name required");
  if (RESERVED.has(raw)) throw new InvalidInput(`"${raw}" is reserved`);
  if (!NAME.test(raw))
    throw new InvalidInput(
      "name must start with a lowercase letter and use only lowercase letters, digits and _ (max 32)",
    );
  return raw as ServerName;
}

function parseRemoteUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new InvalidInput("url is not valid");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new InvalidInput("url must start with http:// or https://");
  return u.toString();
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseEnv(env: Record<string, string> = {}): Record<string, string> {
  for (const k of Object.keys(env))
    if (!ENV_KEY.test(k)) throw new InvalidInput(`"${k}" is not a valid environment variable name`);
  return env;
}

function parseStdio(input: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): IntegrationTransport {
  const command = input.command.trim();
  if (!command) throw new InvalidInput("command required");
  return {
    type: "stdio",
    command,
    args: input.args ?? [],
    envKeys: Object.keys(parseEnv(input.env)),
  };
}

const remoteUrl = (t: IntegrationTransport): string => {
  if (t.type === "stdio") throw new InvalidInput("a local server cannot sign in with OAuth");
  if (t.type === "builtin") throw new InvalidInput("a built-in server does not sign in with MCP");
  return t.url;
};

const bearerHeaders = (token?: string): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

const ownClientOf = (a: IntegrationAuth) =>
  a.kind === "none" ? undefined : "ownClient" in a ? a.ownClient : undefined;

const takesToken = (a: IntegrationAuth) =>
  a.kind === "bearer" || (a.kind === "oauth" && !!a.alternative);

const toolId = (server: string, tool: string) => `mcp__${server}__${tool}`;

const entryTransport = (c: CatalogEntry): IntegrationTransport =>
  c.builtin !== undefined ? { type: "builtin", service: c.builtin } : { type: "http", url: c.url };

/** Lists a remote server's tools straight through the MCP client; Claude Code is not involved. */
async function discover(
  t: IntegrationTransport,
  token?: string,
  env?: Record<string, string>,
): Promise<DiscoveredTool[]> {
  if (t.type === "builtin") return builtinTools(t.service);
  const client = new Client({ name: "tomte", version: "0.1.0" });
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const headers = bearerHeaders(token);
    const transport =
      t.type === "stdio"
        ? new StdioClientTransport({
            command: t.command,
            args: t.args,
            env: { ...getDefaultEnvironment(), ...env },
            stderr: "ignore",
          })
        : t.type === "sse"
          ? new SSEClientTransport(new URL(t.url), {
              requestInit: { headers },
              eventSourceInit: {
                fetch: (u, init) =>
                  fetch(u, { ...init, headers: { ...init?.headers, ...headers } }),
              },
            })
          : new StreamableHTTPClientTransport(new URL(t.url), { requestInit: { headers } });
    await client.connect(transport, { signal: timer.signal });
    const found: DiscoveredTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor }, { signal: timer.signal });
      for (const x of page.tools) {
        const readOnly = x.annotations?.readOnlyHint === true;
        found.push({
          name: x.name,
          description: x.description ?? "",
          readOnly,
          destructive: !readOnly && x.annotations?.destructiveHint !== false,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return found;
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => {});
  }
}

/** Owns integration state, secrets, discovery and tool policy; built like the routines module. */
export function createIntegrations(deps: {
  db: Database;
  secrets: SecretStore;
  /** The data root: skills repositories are cloned into `skills/` and plugin folders built in `plugins/` under it. */
  hostDir: string;
  gitClone?: GitClone;
  catalog?: readonly CatalogEntry[];
  now?: () => number;
  /** The `mcp__<server>__<tool>` names that are locked; the built-in definitions' lock set when omitted, so tests inject one. */
  lockedTools?: ReadonlySet<string>;
  /** Where the host reaches Google; Google's own endpoints for any left out. Tests and smokes point them at a fake. */
  google?: Partial<GoogleEndpoints>;
  /** Where the built-in servers log operations, statuses and ids; the host's error stream when omitted. */
  log?: (line: string) => void;
  onChange: () => void;
  /** Where providers send the browser back after sign-in; the Tomte server's own /oauth/callback. */
  oauthRedirectUrl: string;
}) {
  const { db, secrets, onChange } = deps;
  const now = deps.now ?? Date.now;
  const catalog = deps.catalog ?? CATALOG;
  const clone = deps.gitClone ?? gitClone;
  const lockedTools = deps.lockedTools ?? BUILTIN_LOCKED_TOOLS;
  const google = { ...GOOGLE_ENDPOINTS, ...deps.google };
  const log = deps.log ?? ((line: string) => console.error(line));
  const isLocked = (toolName: string) => lockedTools.has(toolName);
  /** A locked tool never runs on Auto: a stored Auto (a default or an old row) reads as Ask. */
  const effective = (toolName: string, policy: ToolPolicy): ToolPolicy =>
    policy === "auto" && isLocked(toolName) ? "ask" : policy;
  const pluginsDir = join(deps.hostDir, "plugins");
  const clonesDir = join(deps.hostDir, "skills");
  const skillsErrors = new Map<string, string>();

  const info = (c: CatalogEntry): CatalogInfo => ({
    category: c.category,
    tagline: c.tagline,
    ...(c.icon !== undefined && { icon: c.icon }),
    examples: c.examples,
    ...(c.skillsRepo !== undefined && { skillsRepo: c.skillsRepo }),
  });
  const view = (r: IntegrationRecord): Integration => {
    const entry = catalog.find((c) => c.id === r.catalogId);
    const skillsError = skillsErrors.get(r.id);
    return {
      ...r,
      catalog: entry ? info(entry) : null,
      redirectUrl: deps.oauthRedirectUrl,
      label: entry?.label ?? r.name,
      tools: store.tools(db, r.id).map((t) => {
        const id = toolId(r.name, t.name);
        return { ...t, policy: effective(id, t.policy), locked: isLocked(id) };
      }),
      skills: store.skills(db, r.id),
      ...(skillsError !== undefined && { skillsError }),
    };
  };

  /** A built-in gets its row on its first connect, under this id, so the screen keeps showing the same item. A name a custom server took hides the entry. */
  const catalogRowId = (c: CatalogEntry) => `catalog:${c.id}`;
  const unadded = () =>
    catalog.filter((c) => !store.catalogRowExists(db, c.id) && !store.nameTaken(db, c.id));
  const browse = (c: CatalogEntry): Integration => ({
    id: catalogRowId(c),
    catalogId: c.id,
    catalog: info(c),
    label: c.label,
    name: c.id,
    transport: entryTransport(c),
    auth: c.auth,
    redirectUrl: deps.oauthRedirectUrl,
    enabled: true,
    state: "disconnected",
    error: null,
    tools: [],
    skills: [],
    createdAt: 0,
    updatedAt: 0,
  });

  /** The row id to connect: a browsed built-in's id inserts its row first. */
  function added(id: string): string {
    const c = unadded().find((x) => catalogRowId(x) === id);
    if (!c) return id;
    const at = now();
    store.insert(db, {
      id,
      catalogId: c.id,
      name: c.id,
      transport: entryTransport(c),
      auth: c.auth,
      enabled: true,
      state: "disconnected",
      error: null,
      createdAt: at,
      updatedAt: at,
    });
    return id;
  }

  /** A stored row or a browsed built-in, read without inserting anything. */
  function peek(id: string): Pick<Integration, "id" | "auth" | "transport"> {
    const c = unadded().find((x) => catalogRowId(x) === id);
    return c ? browse(c) : need(id);
  }

  const cloneDir = (r: IntegrationRecord) => join(clonesDir, r.name);
  const skillsSource = (r: IntegrationRecord) =>
    r.transport.skillsDir ??
    (catalog.find((c) => c.id === r.catalogId)?.skillsRepo ? cloneDir(r) : undefined);

  /** Clones a built-in's skills repository once; a failure is shown on the card and never blocks the connection. */
  async function ensureClone(r: IntegrationRecord) {
    const repo = catalog.find((c) => c.id === r.catalogId)?.skillsRepo;
    if (!repo || existsSync(cloneDir(r))) return;
    try {
      await clone(repo, cloneDir(r));
    } catch (e) {
      skillsErrors.set(r.id, (e as Error).message);
    }
  }

  /** Reconciles the skills table with what the source holds now; a source that cannot be read keeps the rows and records the error. */
  function syncSkills(r: IntegrationRecord) {
    const source = skillsSource(r);
    if (!source || (!r.transport.skillsDir && !existsSync(source))) return;
    try {
      store.syncSkills(db, r.id, scanSkills(source));
      skillsErrors.delete(r.id);
    } catch (e) {
      skillsErrors.set(r.id, (e as Error).message);
    }
  }

  for (const r of store.list(db)) syncSkills(r);

  /** A catalog entry's auth is catalog data, so rows made by an earlier release follow it. */
  for (const c of catalog) {
    const row = store.list(db).find((r) => r.catalogId === c.id);
    if (row && JSON.stringify(row.auth) !== JSON.stringify(c.auth))
      store.setAuth(db, row.id, c.auth);
  }

  // A built-in row's tools follow its definition: a row converted from a hosted server, or made by a release with fewer tools, shows
  // the whole list at start with the default policies; a tool it already has keeps the owner's policy.
  for (const r of store.list(db))
    if (r.transport.type === "builtin")
      store.upsertTools(db, r.id, builtinTools(r.transport.service), now());

  const readSecret = async (id: string): Promise<Secret> => {
    const raw = await secrets.get(secretName(id));
    return raw ? Secret.parse(JSON.parse(raw)) : {};
  };

  const pending = new Map<
    string,
    { id: string; at: number } & (
      | { provider: OAuthState }
      | {
          google: {
            service: BuiltinService;
            client: OAuthClientInformationMixed;
            verifier: string;
          };
        }
    )
  >();

  /** The bearer credential to present: a stored token, or an OAuth access token refreshed when it is about to expire. */
  async function readToken(
    id: string,
  ): Promise<{ token?: string; expiresAt?: number | undefined }> {
    const s = await readSecret(id);
    if (s.token) return { token: s.token };
    const o = s.oauth;
    if (!o?.tokens) return {};
    if (o.expiresAt !== undefined && now() >= o.expiresAt - EXPIRY_MARGIN_MS) {
      const r = need(id);
      const provider = new OAuthState(deps.oauthRedirectUrl, "", o, now, async (x) =>
        secrets.set(secretName(id), JSON.stringify({ oauth: x } satisfies Secret)),
      );
      try {
        if ((await mcpAuth(provider, { serverUrl: remoteUrl(r.transport) })) !== "AUTHORIZED")
          return {};
      } catch {
        return {};
      }
    }
    return { token: o.tokens.access_token, expiresAt: o.expiresAt };
  }

  const builtinToken = async (id: string) => (await readSecret(id)).oauth?.tokens?.access_token;

  /**
   * Removes a sign-in's tokens. A client the owner entered (the Google services share one by `appLabel`) stays, so connecting
   * again, or connecting another service of the same app, needs no new client ID and secret; anything else in the entry goes.
   */
  async function dropTokens(r: IntegrationRecord) {
    const client = ownClientOf(r.auth) ? (await readSecret(r.id)).oauth?.client : undefined;
    if (client)
      await secrets.set(secretName(r.id), JSON.stringify({ oauth: { client } } satisfies Secret));
    else await secrets.delete(secretName(r.id));
  }

  /** The grant is gone or too narrow: the card asks for a new sign-in and the stale tokens are dropped. Only a connected card changes. */
  async function needsSignIn(id: string) {
    const r = store.get(db, id);
    if (r?.state !== "connected") return;
    await dropTokens(r);
    store.setState(db, id, "needs-auth", null, now());
    onChange();
  }

  const SIGNED_OUT = "Gmail is not signed in; the owner must sign in again in Integrations";

  /** Concurrent callers share one token request per integration. */
  const refreshing = new Map<string, Promise<string>>();

  /** Trades the stored refresh token for a new access token and writes it back, keeping the refresh token Google leaves out. */
  async function refreshBuiltin(id: string): Promise<string> {
    const o = (await readSecret(id)).oauth;
    const refresh = o?.tokens?.refresh_token;
    if (!o?.client || !refresh) throw new GmailError(401, SIGNED_OUT);
    let fresh: OAuthTokens;
    try {
      fresh = await refreshTokens(google, { client: o.client, refreshToken: refresh });
    } catch (e) {
      if (!(e instanceof GrantRevoked)) throw new GmailError(0, (e as Error).message);
      await needsSignIn(id);
      throw new GmailError(401, SIGNED_OUT);
    }
    // A sign-in that ended or was replaced while Google answered owns the entry now; this answer is for the old grant.
    const secret = await readSecret(id);
    const current = secret.oauth;
    if (current?.tokens?.refresh_token !== refresh)
      return current?.tokens?.access_token ?? Promise.reject(new GmailError(401, SIGNED_OUT));
    const next: OAuthSecret = {
      ...current,
      tokens: { ...fresh, refresh_token: fresh.refresh_token ?? refresh },
    };
    if (fresh.expires_in === undefined) delete next.expiresAt;
    else next.expiresAt = now() + fresh.expires_in * 1000;
    await secrets.set(secretName(id), JSON.stringify({ ...secret, oauth: next } satisfies Secret));
    return fresh.access_token;
  }

  /**
   * The access token a built-in server presents, read on every request: the stored one, or a refreshed one when it is within the
   * expiry margin or is `rejected` (the token a request just failed with, unless a refresh has already replaced it).
   */
  async function accessToken(id: string, rejected?: string): Promise<string> {
    const o = (await readSecret(id)).oauth;
    const token = o?.tokens?.access_token;
    if (!token) throw new GmailError(401, SIGNED_OUT);
    const expired = o.expiresAt !== undefined && now() >= o.expiresAt - EXPIRY_MARGIN_MS;
    if (!expired && token !== rejected) return token;
    let shared = refreshing.get(id);
    if (!shared) {
      shared = refreshBuiltin(id).finally(() => refreshing.delete(id));
      refreshing.set(id, shared);
    }
    return shared;
  }

  const need = (id: string) => {
    const r = store.get(db, id);
    if (!r) throw new NotFound("no such integration");
    return r;
  };

  /** Connects with `token` when given, else with the stored one. The token is stored only once the server accepts it. */
  async function connect(id: string, token?: string): Promise<Integration> {
    const r = need(id);
    syncSkills(r);
    const pasted = token !== undefined;
    if (r.auth.kind !== "none" && !token) {
      token = r.transport.type === "builtin" ? await builtinToken(id) : (await readToken(id)).token;
      if (!token) {
        if (r.auth.kind === "oauth") {
          store.setState(db, id, "needs-auth", null, now());
          onChange();
          throw new InvalidInput("sign in to connect");
        }
        throw new InvalidInput("no token stored; paste one to connect");
      }
    }
    try {
      const env = r.transport.type === "stdio" ? (await readSecret(id)).env : undefined;
      store.upsertTools(db, id, await discover(r.transport, token, env), now());
      await ensureClone(r);
      syncSkills(r);
      if (token && pasted && takesToken(r.auth))
        await secrets.set(secretName(id), JSON.stringify({ token } satisfies Secret));
      store.setState(db, id, "connected", null, now());
    } catch (e) {
      store.setState(db, id, "failed", (e as Error).message, now());
    }
    onChange();
    return view(need(id));
  }

  const probe = (id: string) => connect(added(id));

  /** Built-ins whose own clients carry the same `appLabel` (the Google services) sign in with one client the user entered once. */
  async function sharedClient(
    id: string,
    ownClient: OwnClient,
  ): Promise<OAuthClientInformationMixed | undefined> {
    for (const r of store.list(db)) {
      if (r.id === id || ownClientOf(r.auth)?.appLabel !== ownClient.appLabel) continue;
      const client = (await readSecret(r.id)).oauth?.client;
      if (client) return client;
    }
  }

  /** Registers (or reuses) a client, then returns the provider's authorize URL. A dynamically registered client that was registered for another redirect URL is dropped and registers again; its tokens stay stored until the new sign-in completes. A browsed built-in gets its row here; no secret is stored until sign-in completes. */
  async function connectOAuth(
    rawId: string,
    own?: { clientId: string; clientSecret: string },
  ): Promise<OAuthStart> {
    const r = peek(rawId);
    const ownClient = ownClientOf(r.auth);
    if (r.auth.kind !== "oauth" && !ownClient)
      throw new InvalidInput("this integration does not sign in with OAuth");
    for (const [state, p] of pending) if (now() - p.at > SIGN_IN_TTL_MS) pending.delete(state);
    const state = randomBytes(24).toString("base64url");
    const stored = (await readSecret(r.id)).oauth;
    let client = stored?.client;
    if (stored && !ownClient && !registeredRedirects(stored).includes(deps.oauthRedirectUrl))
      client = undefined;
    if (ownClient) {
      const clientId = own?.clientId.trim();
      const clientSecret = own?.clientSecret.trim();
      if (clientId || clientSecret) {
        if (!clientId || !clientSecret)
          throw new InvalidInput("enter both the client ID and the client secret");
        client = { client_id: clientId, client_secret: clientSecret };
      }
      client ??= await sharedClient(r.id, ownClient);
      if (!client)
        throw new InvalidInput(`enter the client ID and secret of your ${ownClient.appLabel}`);
    }
    const id = added(rawId);
    if (r.transport.type === "builtin") {
      if (!client || ownClient?.scope === undefined)
        throw new InvalidInput("no Google client to sign in with");
      const { verifier, challenge } = newPkce();
      pending.set(state, {
        id,
        at: now(),
        google: { service: r.transport.service, client, verifier },
      });
      const authorizeUrl = authorizationUrl(google, {
        clientId: client.client_id,
        redirectUrl: deps.oauthRedirectUrl,
        scope: ownClient.scope,
        state,
        challenge,
      });
      return { authorizeUrl: authorizeUrl.toString() };
    }
    const provider = new OAuthState(deps.oauthRedirectUrl, state, client ? { client } : {}, now);
    let result;
    try {
      result = await mcpAuth(provider, {
        serverUrl: remoteUrl(r.transport),
        ...(ownClient?.scope !== undefined && { scope: ownClient.scope }),
      });
    } catch (e) {
      throw new InvalidInput(`could not start sign-in: ${(e as Error).message}`);
    }
    if (result !== "REDIRECT" || !provider.authorizeUrl)
      throw new InvalidInput("the server did not ask for sign-in");
    pending.set(state, { id, provider, at: now() });
    return { authorizeUrl: provider.authorizeUrl.toString() };
  }

  /** Completes a sign-in from the provider's redirect; an unknown or expired state throws InvalidInput and stores nothing. */
  async function finishOAuth(
    state: string,
    result: { code?: string; error?: string },
  ): Promise<Integration> {
    const p = pending.get(state);
    pending.delete(state);
    if (!p) throw new InvalidInput("unknown or already used sign-in");
    if (now() - p.at > SIGN_IN_TTL_MS)
      throw new InvalidInput("sign-in expired; press Connect again");
    const r = store.get(db, p.id);
    if (!r) throw new NotFound("no such integration");
    try {
      if (!result.code)
        throw new Error(
          result.error ? `sign-in refused: ${result.error}` : "no authorization code returned",
        );
      let tokens: OAuthTokens;
      let secret: OAuthSecret;
      if ("google" in p) {
        tokens = await exchangeCode(google, {
          client: p.google.client,
          code: result.code,
          verifier: p.google.verifier,
          redirectUrl: deps.oauthRedirectUrl,
        });
        secret = {
          client: p.google.client,
          tokens,
          ...(tokens.expires_in !== undefined && { expiresAt: now() + tokens.expires_in * 1000 }),
        };
      } else {
        if (
          (await mcpAuth(p.provider, {
            serverUrl: remoteUrl(r.transport),
            authorizationCode: result.code,
          })) !== "AUTHORIZED"
        )
          throw new Error("the provider did not accept the sign-in");
        tokens = p.provider.secret.tokens!;
        secret = p.provider.secret;
      }
      store.upsertTools(db, r.id, await discover(r.transport, tokens.access_token), now());
      await secrets.set(secretName(r.id), JSON.stringify({ oauth: secret } satisfies Secret));
      store.setState(db, r.id, "connected", null, now());
    } catch (e) {
      store.setState(db, r.id, "failed", (e as Error).message, now());
    }
    onChange();
    return view(need(r.id));
  }

  /** The integration whose server name prefixes `toolName`; the longest name wins when one name prefixes another. */
  function owner(toolName: string): { r: IntegrationRecord; tool: string } | undefined {
    const matches = store
      .list(db)
      .filter((r) => toolName.startsWith(`mcp__${r.name}__`))
      .sort((a, b) => b.name.length - a.name.length);
    const hit =
      matches.find((r) => store.toolPolicy(db, r.id, toolName.slice(`mcp__${r.name}__`.length))) ??
      matches[0];
    return hit && { r: hit, tool: toolName.slice(`mcp__${hit.name}__`.length) };
  }

  const policyOf = (toolName: string): ToolPolicy | undefined => {
    const o = owner(toolName);
    return o && effective(toolName, store.toolPolicy(db, o.r.id, o.tool) ?? "ask");
  };

  return {
    list: (): Integration[] => [...store.list(db).map(view), ...unadded().map(browse)],

    async addCustom(
      input: { name: string; token?: string; skillsDir?: string } & (
        | { url: string; transport: "http" | "sse"; oauth?: boolean }
        | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
      ),
    ): Promise<Integration> {
      const token = input.token?.trim() || undefined;
      const name = parseServerName(input.name);
      const skillsDir = input.skillsDir?.trim() || undefined;
      if (skillsDir && !isAbsolute(skillsDir))
        throw new InvalidInput("skills folder must be an absolute path");
      const transport: IntegrationTransport = {
        ...(input.transport === "stdio"
          ? parseStdio(input)
          : { type: input.transport, url: parseRemoteUrl(input.url) }),
        ...(skillsDir && { skillsDir }),
      };
      if (store.nameTaken(db, name))
        throw new NameTaken(`an integration named "${name}" already exists`);
      const oauth = input.transport !== "stdio" && !!input.oauth;
      if (oauth && token) throw new InvalidInput("choose either a token or OAuth");
      const at = now();
      const id = randomUUID();
      store.insert(db, {
        id,
        catalogId: null,
        name,
        transport,
        auth: oauth
          ? { kind: "oauth", client: "dcr" }
          : token && transport.type !== "stdio"
            ? { kind: "bearer" }
            : { kind: "none" },
        enabled: true,
        state: "disconnected",
        error: null,
        createdAt: at,
        updatedAt: at,
      });
      if (input.transport === "stdio") {
        const env = parseEnv(input.env);
        if (Object.keys(env).length) await secrets.set(secretName(id), JSON.stringify({ env }));
        return connect(id);
      }
      if (oauth) {
        onChange();
        return view(need(id));
      }
      return connect(id, token);
    },

    probe,
    connectOAuth,
    finishOAuth,

    async setBearer(rawId: string, token: string) {
      const t = token.trim();
      if (!t) throw new InvalidInput("token required");
      if (!takesToken(peek(rawId).auth))
        throw new InvalidInput("this integration does not take a token");
      const id = added(rawId);
      return connect(id, t);
    },

    /** Deletes the tokens and takes the tools out of the next turn; tool policies and a client the owner entered stay for a later reconnect. */
    async disconnect(id: string) {
      const r = need(id);
      await dropTokens(r);
      store.setState(db, id, "disconnected", null, now());
      onChange();
    },

    setEnabled(id: string, enabled: boolean) {
      need(id);
      store.setEnabled(db, id, enabled, now());
      onChange();
    },

    setPolicy(id: string, tool: string, policy: ToolPolicy) {
      const r = need(id);
      if (policy === "auto" && isLocked(toolId(r.name, tool)))
        throw new InvalidInput("this tool always asks; its policy can be Ask or Off");
      if (!store.setToolPolicy(db, id, tool, policy)) throw new NotFound("no such tool");
      onChange();
    },

    /** Read-only tools to Auto, the rest to Ask. */
    resetPolicies(id: string) {
      need(id);
      store.resetToolPolicies(db, id);
      onChange();
    },

    setSkillEnabled(id: string, skill: string, enabled: boolean) {
      need(id);
      if (!store.setSkillEnabled(db, id, skill, enabled)) throw new NotFound("no such skill");
      onChange();
    },

    async remove(id: string) {
      const r = need(id);
      store.remove(db, id);
      skillsErrors.delete(id);
      rmSync(join(pluginsDir, r.name), { recursive: true, force: true });
      if (!r.transport.skillsDir) rmSync(cloneDir(r), { recursive: true, force: true });
      await secrets.delete(secretName(id));
      onChange();
    },

    /** Everything a new live query needs: only enabled, connected integrations contribute. */
    async session(filesDir?: string): Promise<SessionIntegrations> {
      const mcpServers: Record<ServerName, McpServerConfig> = {};
      const builtinServers: Record<ServerName, McpSdkServerConfigWithInstance> = {};
      const disallowedTools: string[] = [];
      const plugins: SdkPluginConfig[] = [];
      let expiresAt: number | undefined;
      for (const r of store.list(db)) {
        const active = r.enabled && r.state === "connected";
        const source = skillsSource(r);
        if (source) {
          if (active) syncSkills(r);
          const enabled =
            active && !skillsErrors.has(r.id)
              ? store
                  .skills(db, r.id)
                  .filter((k) => k.enabled)
                  .map((k) => k.name)
              : [];
          const path = buildPlugin(pluginsDir, r.name, source, enabled);
          if (path) plugins.push({ type: "local", path, skipMcpDiscovery: true });
        }
        if (!r.enabled || r.state !== "connected") continue;
        if (r.transport.type === "builtin") {
          if (!(await builtinToken(r.id))) {
            store.setState(db, r.id, "needs-auth", null, now());
            setTimeout(onChange, 0);
            continue;
          }
          builtinServers[r.name as ServerName] = createBuiltinServer(r.transport.service, {
            apiBase: google.gmailApiBase,
            accessToken: (rejected) => accessToken(r.id, rejected),
            signInLost: () => needsSignIn(r.id),
            filesDir,
            log,
          });
        } else if (r.transport.type === "stdio") {
          const env = (await readSecret(r.id)).env;
          mcpServers[r.name as ServerName] = {
            type: "stdio",
            command: r.transport.command,
            args: r.transport.args,
            ...(env && { env }),
          };
        } else {
          const { token, expiresAt: exp } = r.auth.kind === "none" ? {} : await readToken(r.id);
          if (r.auth.kind !== "none" && !token) {
            if (r.auth.kind === "oauth" || ownClientOf(r.auth)) {
              store.setState(db, r.id, "needs-auth", null, now());
              setTimeout(onChange, 0);
            }
            continue;
          }
          if (exp !== undefined)
            expiresAt = Math.min(expiresAt ?? Infinity, exp - EXPIRY_MARGIN_MS);
          mcpServers[r.name as ServerName] = {
            type: r.transport.type,
            url: r.transport.url,
            ...(token && { headers: bearerHeaders(token) }),
          };
        }
        for (const t of store.tools(db, r.id))
          if (t.policy === "off") disallowedTools.push(toolId(r.name, t.name));
      }
      return { mcpServers, builtinServers, disallowedTools, plugins, policyOf, expiresAt };
    },

    policyOf,

    /** needs-auth and failed servers update their card; tools not recorded before are added with their annotation defaults. */
    reconcile(statuses: ServerStatus[]) {
      let changed = false;
      for (const s of statuses) {
        const r = store.list(db).find((x) => x.name === s.name);
        if (!r || !r.enabled || r.state !== "connected") continue;
        if (s.status === "needs-auth" || s.status === "failed") {
          // Claude Code reports a rejected bearer as `failed` (HTTP 401), never `needs-auth`; for an OAuth integration that means the grant is gone.
          const signIn =
            s.status === "needs-auth" || (r.auth.kind === "oauth" && /\b401\b/.test(s.error ?? ""));
          store.setState(
            db,
            r.id,
            signIn ? "needs-auth" : "failed",
            signIn ? null : (s.error ?? "connection failed"),
            now(),
          );
          changed = true;
        } else if (s.status === "connected" && s.tools) {
          const known = new Set(store.tools(db, r.id).map((t) => t.name));
          const added = s.tools
            .filter((t) => !known.has(t.name))
            .map((t) => {
              const readOnly = t.annotations?.readOnly === true;
              return {
                name: t.name,
                description: t.description ?? "",
                readOnly,
                destructive: !readOnly && t.annotations?.destructive !== false,
              };
            });
          if (added.length) {
            store.upsertTools(db, r.id, added, now());
            changed = true;
          }
        }
      }
      if (changed) onChange();
    },

    /** Called live on every tool call, so Off and Ask hold on the very next call. */
    decide(toolName: string): ToolDecision | undefined {
      if (!toolName.startsWith("mcp__")) return undefined;
      const o = owner(toolName);
      if (!o || !o.r.enabled || o.r.state !== "connected") return "deny";
      const policy = effective(toolName, store.toolPolicy(db, o.r.id, o.tool) ?? "ask");
      return policy === "off" ? "deny" : policy === "auto" ? "allow" : "ask";
    },

    locked: isLocked,

    async prepareApproval(toolName: string, input: Record<string, unknown>) {
      const o = owner(toolName);
      if (o?.r.transport.type !== "builtin") return { input };
      const { id } = o.r;
      return prepareBuiltinApproval(
        o.r.transport.service,
        {
          apiBase: google.gmailApiBase,
          accessToken: (rejected) => accessToken(id, rejected),
          signInLost: () => needsSignIn(id),
          log,
        },
        o.tool,
        input,
      );
    },
  };
}

export type Integrations = ReturnType<typeof createIntegrations>;
