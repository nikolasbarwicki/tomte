import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { getBot, listBots, botFilesPath } from "../bots/index.ts";
import { createBrowser, type BrowserEndpoint, type BrowserRuntimeOptions, type LiveViewOptions, type SandboxStatus } from "../browser/index.ts";
import { createCredentials } from "../credentials/index.ts";
import { createHandoffs, type BotsEndpoint } from "../handoffs/index.ts";
import { combineLeases, type HostServersSource, type ResolvedCli } from "../harness/index.ts";
import { createIntegrations } from "../integrations/index.ts";
import { createRoutines } from "../routines/index.ts";
import type { SecretStore } from "../platform/secrets.ts";
import { TokenRegistry } from "../platform/tokens.ts";
import type { CredentialsEvent, IntegrationsEvent, RoutinesEvent } from "../contract/events.ts";
import { createApi } from "./api/index.ts";
import { oauthCallback } from "./api/integrations.ts";
import { createChats } from "./chats.ts";
import { createEventStream } from "./events.ts";
import { watchHerdr } from "./herdr.ts";
import { createRequestListener, hostRoutes } from "./http.ts";
import { createTranscripts } from "./transcript.ts";
import { filesEvent, memoryEvents } from "./views.ts";

export interface HostServerOptions {
  /** The workspace directory; bots and their files live under it. */
  cwd: string;
  /** Port to listen on, on 127.0.0.1; 0 picks a free one. */
  port: number;
  cli: ResolvedCli;
  db: Database;
  secrets: SecretStore;
  /** The bot to open first; the most recently active bot when omitted. */
  botId?: string;
  /** Serve the web UI through Vite. */
  vite: boolean;
  /** Watch herdr for updates from other agents. */
  herdr: boolean;
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
  url: string;
  /** The browser endpoint's token leases, so a caller can act as a bot session. */
  browser: BrowserEndpoint;
  /** The bots endpoint's token leases, so a caller can act as a bot session. */
  bots: BotsEndpoint;
  currentBotId(): string | undefined;
  /** Closes every thread and browser, then stops listening. */
  close(): Promise<void>;
  /** Everything the browser and handoff features hold for a bot being deleted. Does not touch the bot's files or config. */
  removeBot(botId: string): Promise<void>;
}

export async function createHostServer(o: HostServerOptions): Promise<HostServer> {
  const { cwd, cli, db, secrets } = o;
  const initial = o.botId ? getBot(cwd, o.botId) : listBots(cwd)[0];
  if (o.botId && !initial) throw new Error(`no bot ${o.botId} in ${cwd}`);

  /** Unset until startup finishes (503 meanwhile); the socket opens first so the port is known, but nothing is served yet. */
  let serve: RequestListener | undefined;
  const http = createServer((req, res) => (serve ? serve(req, res) : void res.writeHead(503).end()));
  const listening = Promise.withResolvers<void>();
  http.once("error", listening.reject);
  http.listen(o.port, "127.0.0.1", listening.resolve);
  await listening.promise;
  const port = (http.address() as AddressInfo).port;

  const events = createEventStream();
  const { broadcast } = events;
  const credentials = createCredentials({ db, secrets, onChange: () => broadcast(credentialsEvent()) });
  const tokens = new TokenRegistry();
  const browser = await createBrowser({
    secrets,
    credentials,
    tokens,
    port: () => port,
    bot: (botId) => getBot(cwd, botId),
    filesDir: (botId) => botFilesPath(cwd, botId),
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
    port: () => port,
    show: (botId, card) => chats.emitTo(botId, card),
    cards: () => listBots(cwd).map((bot) => ({ id: bot.id, name: bot.name, description: bot.purpose, status: chats.isWorking(bot.id) ? "working" : "idle" })),
    botName: (botId) => getBot(cwd, botId)?.name,
    filesDir: (botId) => botFilesPath(cwd, botId),
    deliver: (botId, text) =>
      void chats.deliver(botId, text).catch((e) => console.error(`[bots] delivery to ${botId} failed: ${(e as Error).message}`)),
  });
  const hostServers: HostServersSource = (botId) => combineLeases([browser.endpoint.lease(botId), handoffs.endpoint.lease(botId)]);
  const integrations = createIntegrations({
    db,
    hostDir: join(cwd, ".host"),
    secrets,
    oauthRedirectUrl: `http://127.0.0.1:${port}/oauth/callback`,
    onChange: () => {
      broadcast(integrationsEvent());
      chats.reconfigure(undefined, "integrations changed");
    },
  });
  const transcripts = createTranscripts({ cwd, db, handoffs });
  const chats = createChats({
    cwd,
    cli,
    db,
    integrations,
    hostServers,
    handoffs,
    transcript: transcripts.transcript,
    pendingWaits: browser.pendingWaits,
    routinesEvent: (botId) => routinesEvent(botId),
    broadcast,
  });
  const routines = createRoutines({
    db,
    cwd,
    execute: chats.execute,
    onChange: (botId) => {
      if (botId === chats.currentBotId()) broadcast(routinesEvent(botId));
    },
  });
  const integrationsEvent = (): IntegrationsEvent => ({ type: "integrations", integrations: integrations.list() });
  const credentialsEvent = (): CredentialsEvent => ({ type: "credentials", credentials: credentials.list() });
  const routinesEvent = (botId: string): RoutinesEvent => ({ type: "routines", botId, routines: routines.list(botId) });

  const stopHerdr = !o.herdr ? undefined : watchHerdr((title, body) => chats.notify("herdr", title, body), (l) => console.error(l));

  if (initial) await chats.switchTo(initial);
  void transcripts
    .backfillActivity()
    .then(chats.announceBots)
    .catch((e) => console.error(`[host] activity backfill failed: ${(e as Error).message}`));

  const webRoot = fileURLToPath(new URL("../../web", import.meta.url));
  const vite = o.vite
    ? await createVite({
        root: webRoot,
        plugins: [react(), tailwindcss()],
        resolve: { alias: { "@": webRoot } },
        server: { middlewareMode: true, hmr: { server: http } },
        appType: "spa",
      })
    : undefined;

  const api = createApi({
    cwd,
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
      return [chats.botsEvent(), integrationsEvent(), credentialsEvent(), ...memoryEvents(cwd, botId), filesEvent(cwd, botId), ...chats.notices(), ...chats.replayOpen()];
    },
  });
  const routes = hostRoutes({ browser, handoffs, oauthCallback: (_req, res, url) => oauthCallback(integrations, res, url.searchParams), api });

  routines.start();
  handoffs.redeliverOpen();
  serve = createRequestListener(routes, (req, res) => (vite ? vite.middlewares(req, res) : void res.writeHead(404).end()));

  return {
    port,
    url: `http://127.0.0.1:${port}`,
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
