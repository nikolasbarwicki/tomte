import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { McpServerConfig, SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import type {
  CatalogInfo,
  Integration,
  IntegrationAuth,
  IntegrationTransport,
  OwnClient,
  ToolPolicy,
} from "@claudebot/contract/events";
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
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { InvalidInput, NotFound } from "../platform/errors.ts";
import { secretName, type SecretStore } from "../platform/secrets.ts";
import { CATALOG, type CatalogEntry } from "./catalog.ts";
import { buildPlugin, gitClone, scanSkills, type GitClone } from "./skills.ts";
import * as store from "./store.ts";
import type { DiscoveredTool, IntegrationRecord } from "./store.ts";

export type { ToolPolicy };
export type ServerName = string & { readonly __brand: "ServerName" };
export type ToolDecision = "deny" | "ask" | "allow";

export type SessionIntegrations = {
  mcpServers: Record<ServerName, McpServerConfig>;
  disallowedTools: string[];
  plugins: SdkPluginConfig[];
  /** Policy of an integration tool by its `mcp__<server>__<tool>` name; undefined when no integration owns it. */
  policyOf(toolName: string): ToolPolicy | undefined;
  /** Epoch ms after which this configuration must be rebuilt. */
  expiresAt?: number | undefined;
};

/** What a thread needs from the integrations module. */
export interface IntegrationsSource {
  session(): Promise<SessionIntegrations>;
  /** undefined: not an integration tool, so the caller's own rules apply. */
  decide(toolName: string): ToolDecision | undefined;
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
const RESERVED = new Set(["host"]);
const DISCOVERY_TIMEOUT_MS = 15_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;

/** The OAuth half of an integration's keychain entry: the registered client and the current tokens. */
type OAuthSecret = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number | undefined;
};
type Secret = { token?: string; env?: Record<string, string>; oauth?: OAuthSecret };

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
      client_name: "Claudebot",
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
  return t.url;
};

const bearerHeaders = (token?: string): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

const ownClientOf = (a: IntegrationAuth) =>
  a.kind === "none" ? undefined : "ownClient" in a ? a.ownClient : undefined;

const takesToken = (a: IntegrationAuth) =>
  a.kind === "bearer" || (a.kind === "oauth" && !!a.alternative);

const toolId = (server: string, tool: string) => `mcp__${server}__${tool}`;

/** Lists a remote server's tools straight through the MCP client; Claude Code is not involved. */
async function discover(
  t: IntegrationTransport,
  token?: string,
  env?: Record<string, string>,
): Promise<DiscoveredTool[]> {
  const client = new Client({ name: "claudebot", version: "0.1.0" });
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
  onChange: () => void;
  /** Where providers send the browser back after sign-in; the Claudebot server's own /oauth/callback. */
  oauthRedirectUrl: string;
}) {
  const { db, secrets, onChange } = deps;
  const now = deps.now ?? Date.now;
  const catalog = deps.catalog ?? CATALOG;
  const clone = deps.gitClone ?? gitClone;
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
      tools: store.tools(db, r.id),
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
    transport: { type: "http", url: c.url },
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
      transport: { type: "http", url: c.url },
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

  const readSecret = async (id: string): Promise<Secret> => {
    const raw = await secrets.get(secretName(id));
    return raw ? (JSON.parse(raw) as Secret) : {};
  };

  const pending = new Map<string, { id: string; provider: OAuthState; at: number }>();

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
      token = (await readToken(id)).token;
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

  /** Registers (or reuses) a client, then returns the provider's authorize URL. A browsed built-in gets its row here; no secret is stored until sign-in completes. */
  async function connectOAuth(
    rawId: string,
    own?: { clientId: string; clientSecret: string },
  ): Promise<{ authorizeUrl: string }> {
    const r = peek(rawId);
    const ownClient = ownClientOf(r.auth);
    if (r.auth.kind !== "oauth" && !ownClient)
      throw new InvalidInput("this integration does not sign in with OAuth");
    for (const [state, p] of pending) if (now() - p.at > SIGN_IN_TTL_MS) pending.delete(state);
    const state = randomBytes(24).toString("base64url");
    let client = (await readSecret(r.id)).oauth?.client;
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
      if (
        (await mcpAuth(p.provider, {
          serverUrl: remoteUrl(r.transport),
          authorizationCode: result.code,
        })) !== "AUTHORIZED"
      )
        throw new Error("the provider did not accept the sign-in");
      const tokens = p.provider.secret.tokens!;
      store.upsertTools(db, r.id, await discover(r.transport, tokens.access_token), now());
      await secrets.set(
        secretName(r.id),
        JSON.stringify({ oauth: p.provider.secret } satisfies Secret),
      );
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
    return o && (store.toolPolicy(db, o.r.id, o.tool) ?? "ask");
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

    /** Deletes the secret and takes the tools out of the next turn; tool policies stay for a later reconnect. */
    async disconnect(id: string) {
      need(id);
      await secrets.delete(secretName(id));
      store.setState(db, id, "disconnected", null, now());
      onChange();
    },

    setEnabled(id: string, enabled: boolean) {
      need(id);
      store.setEnabled(db, id, enabled, now());
      onChange();
    },

    setPolicy(id: string, tool: string, policy: ToolPolicy) {
      need(id);
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
    async session(): Promise<SessionIntegrations> {
      const mcpServers: Record<ServerName, McpServerConfig> = {};
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
        if (r.transport.type === "stdio") {
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
      return { mcpServers, disallowedTools, plugins, policyOf, expiresAt };
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
      const policy = store.toolPolicy(db, o.r.id, o.tool) ?? "ask";
      return policy === "off" ? "deny" : policy === "auto" ? "allow" : "ask";
    },
  };
}

export type Integrations = ReturnType<typeof createIntegrations>;
