import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";

import type {
  CredentialsEvent,
  IntegrationsEvent,
  RoutinesEvent,
} from "@claudebot/contract/events";

import { getBot, listBots, botFilesPath, reveal } from "../bots/index.ts";
import {
  createBrowser,
  sandboxStatus,
  type BrowserEndpoint,
  type BrowserRuntimeOptions,
  type LiveViewOptions,
  type SandboxStatus,
} from "../browser/index.ts";
import { createCredentials } from "../credentials/index.ts";
import { createDeviceAuth, type DeviceAuth } from "../device-auth/index.ts";
import { createHandoffs, type BotsEndpoint } from "../handoffs/index.ts";
import {
  combineLeases,
  createClaudeAccess,
  type HostServersSource,
  type ResolvedCli,
  type SignInState,
} from "../harness/index.ts";
import { createIntegrations } from "../integrations/index.ts";
import { AGENT_ADDRESS, clientOrigin, agentOrigin, type HostConfig } from "../platform/config.ts";
import { openFileSecrets } from "../platform/file-secrets.ts";
import { keychainSecrets, type SecretStore } from "../platform/secrets.ts";
import { TokenRegistry } from "../platform/tokens.ts";
import { ensureWorkspace } from "../platform/workspace.ts";
import { createRoutines } from "../routines/index.ts";
import { serveUi, type UiAssets } from "../ui/index.ts";
import { hostInfoRoute } from "./api/host-info.ts";
import { createApi } from "./api/index.ts";
import { oauthCallback } from "./api/integrations.ts";
import { pairRoute } from "./api/pair.ts";
import { withBoundary } from "./boundary.ts";
import { createChats } from "./chats.ts";
import { createDeviceSessions } from "./device-sessions.ts";
import { createEventStream } from "./events.ts";
import { watchHerdr } from "./herdr.ts";
import { agentRoutes, clientRoutes, createRequestListener } from "./http.ts";
import { createHostIsolation } from "./isolation.ts";
import { openListener } from "./listener.ts";
import { createTranscripts } from "./transcript.ts";
import { filesEvent, memoryEvents } from "./views.ts";

export interface HostServerOptions {
  /** Deployment choices parsed once at startup: the data root, where to listen and what URL users reach, Vite and herdr. */
  config: HostConfig;
  cli: ResolvedCli;
  db: Database;
  /** Where secrets live; the store `config.secrets` names (the OS keychain or the encrypted file) when omitted. */
  secrets?: SecretStore;
  /** The bot to open first; the most recently active bot when omitted. */
  botId?: string | undefined;
  /** Overrides for the browser engine, Chrome and the engine's environment. */
  browser?: BrowserRuntimeOptions;
  /** Whether the shell sandbox can run; checks this platform when omitted. */
  sandbox?: () => SandboxStatus;
  /** Shows a path in the OS file manager when `config.reveal` is on; the real file manager when omitted. */
  reveal?: (path: string, log: (line: string) => void) => void;
  /** Pacing overrides for the browser live view. */
  liveView?: Pick<LiveViewOptions, "maxFps" | "retryMs">;
  /** How long the user may hold a bot's browser without input before control ends; 30 minutes when omitted. */
  takeoverInactivityMs?: number;
  /** The built web UI the client listener serves; every request no route claims answers 404 without it. Ignored when `config.vite` is on. */
  ui?: UiAssets;
  /** The clock device auth reads for pairing code expiry, in epoch milliseconds; the system clock when omitted. */
  now?: () => number;
}

export interface HostServer {
  /** The client listener's loopback URL: the web UI, `/api/*`, live view and `/oauth/callback`. */
  clientUrl: string;
  /** The agent listener's loopback URL: the browser endpoint, the bots endpoint and the credential exchange. */
  agentUrl: string;
  /** The origin users and OAuth providers reach. */
  publicUrl: string;
  /** The browser endpoint's token leases, so a caller can act as a bot session. */
  browser: BrowserEndpoint;
  /** The bots endpoint's token leases, so a caller can act as a bot session. */
  bots: BotsEndpoint;
  /** Pairing codes and device tokens, so a caller can pair a device without going through the exchange. */
  devices: DeviceAuth;
  currentBotId: () => string | undefined;
  /** Whether the Claude CLI is signed in, as the last `auth status` reported; always `unknown` in local mode, which never checks. */
  signInState: () => SignInState;
  /** Closes every thread and browser, then stops listening. */
  close(): Promise<void>;
  /** Everything the browser and handoff features hold for a bot being deleted. Does not touch the bot's files or config. */
  removeBot(botId: string): Promise<void>;
}

/** The store `config.secrets` names; throws when the encrypted file cannot be opened with its key. */
function openSecrets({ dataRoot, secrets }: HostConfig): SecretStore {
  return secrets.backend === "file" ? openFileSecrets(dataRoot, secrets.keyFile) : keychainSecrets;
}

export async function createHostServer(o: HostServerOptions): Promise<HostServer> {
  const { cli, db } = o;
  const dataRoot = o.config.dataRoot;
  const secrets = o.secrets ?? openSecrets(o.config);
  const cwd = ensureWorkspace(dataRoot);
  const initial = o.botId ? getBot(dataRoot, o.botId) : listBots(dataRoot)[0];
  if (o.botId && !initial) throw new Error(`no bot ${o.botId} in ${dataRoot}`);

  const clientListener = await openListener(o.config.bind.address, o.config.bind.port);
  const agentListener = await openListener(AGENT_ADDRESS, 0).catch(async (e) => {
    await clientListener.stop();
    throw e;
  });
  const clientAt = clientOrigin(o.config, clientListener.port);
  const agentAt = agentOrigin(agentListener.port);

  const sandbox = o.sandbox ?? (() => sandboxStatus());
  const events = createEventStream();
  const { broadcast } = events;
  const credentials = createCredentials({
    db,
    secrets,
    onChange: () => broadcast(credentialsEvent()),
  });
  const tokens = new TokenRegistry();
  const browser = await createBrowser({
    dataRoot,
    secrets,
    headedAllowed: o.config.headedBrowser,
    credentials,
    tokens,
    agent: agentAt,
    bot: (botId) => getBot(dataRoot, botId),
    filesDir: (botId) => botFilesPath(dataRoot, botId),
    unattended: (botId) => chats.unattended(botId),
    emit: (botId, e) => chats.emitTo(botId, e),
    deliver: (botId, text) => void chats.deliver(botId, text),
    sandbox,
    ...(o.browser !== undefined && { runtime: o.browser }),
    ...(o.liveView !== undefined && { liveView: o.liveView }),
    ...(o.takeoverInactivityMs !== undefined && { takeoverInactivityMs: o.takeoverInactivityMs }),
  });
  const handoffs = createHandoffs({
    db,
    tokens,
    host: agentAt,
    show: (botId, card) => chats.emitTo(botId, card),
    cards: () =>
      listBots(dataRoot).map((bot) => ({
        id: bot.id,
        name: bot.name,
        description: bot.purpose,
        status: chats.isWorking(bot.id) ? "working" : "idle",
      })),
    botName: (botId) => getBot(dataRoot, botId)?.name,
    filesDir: (botId) => botFilesPath(dataRoot, botId),
    deliver: (botId, text) =>
      void chats
        .deliver(botId, text)
        .catch((e) => console.error(`[bots] delivery to ${botId} failed: ${(e as Error).message}`)),
  });
  const isolation = createHostIsolation({ config: o.config, sandbox });
  const hostServers: HostServersSource = (botId) =>
    combineLeases([
      browser.endpoint.lease(botId),
      handoffs.endpoint.lease(botId),
      isolation(botId),
    ]);
  /** Other bots' directories are on every bot's deny-read list, so a bot that appears or goes reaches the open sessions. */
  const botsChanged = () => {
    if (o.config.isolateAllBots) chats.reconfigure(undefined, "bots changed");
  };
  const integrations = createIntegrations({
    db,
    hostDir: dataRoot,
    secrets,
    oauthRedirectUrl: `${clientAt.publicUrl}/oauth/callback`,
    onChange: () => {
      broadcast(integrationsEvent());
      chats.reconfigure(undefined, "integrations changed");
    },
  });
  const transcripts = createTranscripts({ cwd, dataRoot, db, handoffs });
  const claude = createClaudeAccess(o.config, cli);
  const chats = createChats({
    cwd,
    dataRoot,
    cli,
    claude,
    db,
    integrations,
    hostServers,
    approveAll: !o.config.askApproval,
    handoffs,
    transcript: (bot) => transcripts.transcript(bot),
    pendingWaits: browser.pendingWaits,
    routinesEvent: (botId) => routinesEvent(botId),
    broadcast,
  });
  const routines = createRoutines({
    db,
    dataRoot,
    execute: chats.execute,
    onChange: (botId) => {
      if (botId === chats.currentBotId()) broadcast(routinesEvent(botId));
    },
  });
  const integrationsEvent = (): IntegrationsEvent => ({
    type: "integrations",
    integrations: integrations.list(),
  });
  const credentialsEvent = (): CredentialsEvent => ({
    type: "credentials",
    credentials: credentials.list(),
  });
  const routinesEvent = (botId: string): RoutinesEvent => ({
    type: "routines",
    botId,
    routines: routines.list(botId),
  });

  const stopHerdr = !o.config.herdr
    ? undefined
    : watchHerdr(
        (title, body) => chats.notify("herdr", title, body),
        (l) => console.error(l),
      );

  if (o.config.mode === "remote") void claude.checkSignIn();
  if (initial) await chats.switchTo(initial);
  void transcripts
    .backfillActivity()
    .then(chats.announceBots)
    .catch((e) => console.error(`[host] activity backfill failed: ${(e as Error).message}`));

  const webRoot = fileURLToPath(new URL("../../../web", import.meta.url));
  const vite = o.config.vite
    ? await import("vite").then((v) =>
        v.createServer({
          root: webRoot,
          server: { middlewareMode: true, hmr: { server: clientListener.http } },
          appType: "spa",
        }),
      )
    : undefined;
  const serveBuiltUi = serveUi(o.ui ?? { read: async () => undefined });

  const devices = createDeviceAuth({ db, ...(o.now !== undefined && { now: o.now }) });
  const sessions = createDeviceSessions();
  const api = createApi({
    botsChanged,
    cwd,
    headedBrowser: o.config.headedBrowser,
    dataRoot,
    cli,
    db,
    chats,
    browser,
    routines,
    integrations,
    credentials,
    devices,
    sessions,
    events,
    reveal: o.config.reveal ? (o.reveal ?? reveal) : undefined,
    snapshot: () => {
      const botId = chats.currentBotId();
      return [
        chats.botsEvent(),
        integrationsEvent(),
        credentialsEvent(),
        ...memoryEvents(dataRoot, botId),
        filesEvent(dataRoot, botId),
        ...chats.notices(),
        ...chats.replayOpen(),
      ];
    },
  });
  const client = clientRoutes({
    browser,
    oauthCallback: (_req, res, url) => oauthCallback(integrations, res, url.searchParams),
    hostInfo: hostInfoRoute({
      config: o.config,
      signInState: () => claude.signInState(),
      sandbox: () => browser.sandbox(),
    }),
    pair: pairRoute(devices, clientAt.publicUrl),
    api,
  });
  const agent = agentRoutes({ browser, handoffs });

  routines.start();
  handoffs.redeliverOpen();
  clientListener.serve(
    withBoundary(
      clientAt,
      devices,
      sessions,
      createRequestListener(client, (req, res) =>
        vite ? vite.middlewares(req, res) : serveBuiltUi(req, res),
      ),
    ),
  );
  agentListener.serve(createRequestListener(agent, (_req, res) => void res.writeHead(404).end()));

  return {
    clientUrl: clientAt.localUrl,
    agentUrl: agentAt.localUrl,
    publicUrl: clientAt.publicUrl,
    browser: browser.endpoint,
    bots: handoffs.endpoint,
    devices,
    currentBotId: chats.currentBotId,
    signInState: () => claude.signInState(),
    async removeBot(botId) {
      await browser.removeBot(botId);
      handoffs.removeBot(botId);
      botsChanged();
    },
    async close() {
      clientListener.pause();
      agentListener.pause();
      chats.close();
      stopHerdr?.();
      routines.stop();
      await browser.close();
      await vite?.close();
      await Promise.all([clientListener.stop(), agentListener.stop()]);
    },
  };
}
