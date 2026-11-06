import type { Database } from "bun:sqlite";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import type {
  CredentialsEvent,
  IntegrationsEvent,
  RoutinesEvent,
} from "@claudebot/contract/events";
import { createServer as createVite } from "vite";

import { getBot, listBots, botFilesPath } from "../bots/index.ts";
import {
  createBrowser,
  type BrowserEndpoint,
  type BrowserRuntimeOptions,
  type LiveViewOptions,
  type SandboxStatus,
} from "../browser/index.ts";
import { createCredentials } from "../credentials/index.ts";
import { createHandoffs, type BotsEndpoint } from "../handoffs/index.ts";
import { combineLeases, type HostServersSource, type ResolvedCli } from "../harness/index.ts";
import { createIntegrations } from "../integrations/index.ts";
import { hostOrigin, type HostConfig } from "../platform/config.ts";
import type { SecretStore } from "../platform/secrets.ts";
import { TokenRegistry } from "../platform/tokens.ts";
import { ensureWorkspace } from "../platform/workspace.ts";
import { createRoutines } from "../routines/index.ts";
import { createApi } from "./api/index.ts";
import { oauthCallback } from "./api/integrations.ts";
import { createChats } from "./chats.ts";
import { createEventStream } from "./events.ts";
import { watchHerdr } from "./herdr.ts";
import { createRequestListener, hostRoutes } from "./http.ts";
import { createTranscripts } from "./transcript.ts";
import { filesEvent, memoryEvents } from "./views.ts";

export interface HostServerOptions {
  /** Deployment choices parsed once at startup: the data root, where to listen and what URL users reach, Vite and herdr. */
  config: HostConfig;
  cli: ResolvedCli;
  db: Database;
  secrets: SecretStore;
  /** The bot to open first; the most recently active bot when omitted. */
  botId?: string;
  /** Overrides for the browser engine, Chrome and the engine's environment. */
  browser?: BrowserRuntimeOptions;
  /** Whether the shell sandbox can run; checks this platform when omitted. */
  sandbox?: () => SandboxStatus;
  /** Pacing overrides for the browser live view. */
  liveView?: Pick<LiveViewOptions, "maxFps" | "retryMs">;
  /** How long the user may hold a bot's browser without input before control ends; 30 minutes when omitted. */
  takeoverInactivityMs?: number;
}

export interface HostServer {
  port: number;
  /** The loopback URL the host listens on. */
  url: string;
  /** The origin users and OAuth providers reach. */
  publicUrl: string;
  /** The browser endpoint's token leases, so a caller can act as a bot session. */
  browser: BrowserEndpoint;
  /** The bots endpoint's token leases, so a caller can act as a bot session. */
  bots: BotsEndpoint;
  currentBotId: () => string | undefined;
  /** Closes every thread and browser, then stops listening. */
  close(): Promise<void>;
  /** Everything the browser and handoff features hold for a bot being deleted. Does not touch the bot's files or config. */
  removeBot(botId: string): Promise<void>;
}

export async function createHostServer(o: HostServerOptions): Promise<HostServer> {
  const { cli, db, secrets } = o;
  const dataRoot = o.config.dataRoot;
  const cwd = ensureWorkspace(dataRoot);
  const initial = o.botId ? getBot(dataRoot, o.botId) : listBots(dataRoot)[0];
  if (o.botId && !initial) throw new Error(`no bot ${o.botId} in ${dataRoot}`);

  /** Unset until startup finishes (503 meanwhile); the socket opens first so the port is known, but nothing is served yet. */
  let serve: RequestListener | undefined;
  const http = createServer((req, res) =>
    serve ? serve(req, res) : void res.writeHead(503).end(),
  );
  const listening = Promise.withResolvers<void>();
  http.once("error", listening.reject);
  http.listen(o.config.bind.port, o.config.bind.address, listening.resolve);
  await listening.promise;
  const port = (http.address() as AddressInfo).port;
  const origin = hostOrigin(o.config, port);

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
    credentials,
    tokens,
    host: origin,
    bot: (botId) => getBot(dataRoot, botId),
    filesDir: (botId) => botFilesPath(dataRoot, botId),
    unattended: (botId) => chats.unattended(botId),
    emit: (botId, e) => chats.emitTo(botId, e),
    deliver: (botId, text) => void chats.deliver(botId, text),
    sandbox: o.sandbox,
    runtime: o.browser,
    liveView: o.liveView,
    takeoverInactivityMs: o.takeoverInactivityMs,
  });
  const handoffs = createHandoffs({
    db,
    tokens,
    host: origin,
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
  const hostServers: HostServersSource = (botId) =>
    combineLeases([browser.endpoint.lease(botId), handoffs.endpoint.lease(botId)]);
  const integrations = createIntegrations({
    db,
    hostDir: dataRoot,
    secrets,
    oauthRedirectUrl: `${origin.publicUrl}/oauth/callback`,
    onChange: () => {
      broadcast(integrationsEvent());
      chats.reconfigure(undefined, "integrations changed");
    },
  });
  const transcripts = createTranscripts({ cwd, dataRoot, db, handoffs });
  const chats = createChats({
    cwd,
    dataRoot,
    cli,
    db,
    integrations,
    hostServers,
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

  if (initial) await chats.switchTo(initial);
  void transcripts
    .backfillActivity()
    .then(chats.announceBots)
    .catch((e) => console.error(`[host] activity backfill failed: ${(e as Error).message}`));

  const webRoot = fileURLToPath(new URL("../../../web", import.meta.url));
  const vite = o.config.vite
    ? await createVite({
        root: webRoot,
        server: { middlewareMode: true, hmr: { server: http } },
        appType: "spa",
      })
    : undefined;

  const api = createApi({
    cwd,
    dataRoot,
    cli,
    db,
    chats,
    browser,
    routines,
    integrations,
    credentials,
    events,
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
  const routes = hostRoutes({
    browser,
    handoffs,
    oauthCallback: (_req, res, url) => oauthCallback(integrations, res, url.searchParams),
    api,
  });

  routines.start();
  handoffs.redeliverOpen();
  serve = createRequestListener(routes, (req, res) =>
    vite ? vite.middlewares(req, res) : void res.writeHead(404).end(),
  );

  return {
    port,
    url: origin.localUrl,
    publicUrl: origin.publicUrl,
    browser: browser.endpoint,
    bots: handoffs.endpoint,
    currentBotId: chats.currentBotId,
    async removeBot(botId) {
      await browser.removeBot(botId);
      handoffs.removeBot(botId);
    },
    async close() {
      serve = undefined;
      chats.close();
      stopHerdr?.();
      routines.stop();
      await browser.close();
      await vite?.close();
      http.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      http.close(() => closed.resolve());
      await closed.promise;
    },
  };
}
