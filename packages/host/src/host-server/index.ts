import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";

import type {
  CredentialsEvent,
  IntegrationsEvent,
  RoutinesEvent,
} from "@claudebot/contract/events";

import {
  allowsTool,
  allowTool,
  createUsageMeter,
  getBot,
  listBots,
  botFilesPath,
  currentSession,
  deleteActivity,
  deleteAllowances,
  reveal,
  trashBot,
} from "../bots/index.ts";
import {
  createBrowser,
  sandboxStatus,
  type BrowserEndpoint,
  type BrowserRuntimeOptions,
  type LiveViewOptions,
  type SandboxStatus,
} from "../browser/index.ts";
import {
  createCards,
  createChannels,
  createTelegramChannel,
  type Channel,
  type Channels,
  type TelegramOptions,
} from "../channels/index.ts";
import { createCredentials } from "../credentials/index.ts";
import { createDeviceAuth, type DeviceAuth } from "../device-auth/index.ts";
import { createEvents, eventsPath } from "../events/index.ts";
import { createHandoffs, type BotsEndpoint } from "../handoffs/index.ts";
import {
  combineLeases,
  createClaudeAccess,
  type HostServersSource,
  type ResolvedCli,
  type SignInState,
} from "../harness/index.ts";
import { createIntegrations } from "../integrations/index.ts";
import { createLoopStore } from "../loop/index.ts";
import { AGENT_ADDRESS, clientOrigin, agentOrigin, type HostConfig } from "../platform/config.ts";
import { openFileSecrets } from "../platform/file-secrets.ts";
import { keychainSecrets, type SecretStore } from "../platform/secrets.ts";
import { TokenRegistry } from "../platform/tokens.ts";
import { ensureWorkspace } from "../platform/workspace.ts";
import { createPresence } from "../presence/index.ts";
import {
  createRoutines,
  createRoutinesEndpoint,
  type RoutinesEndpoint,
} from "../routines/index.ts";
import { serveUi, type UiAssets } from "../ui/index.ts";
import { createWaits } from "../waits/index.ts";
import { absenceActions } from "./absence.ts";
import { externalEventsRoute } from "./api/external-events.ts";
import { hostInfoRoute } from "./api/host-info.ts";
import { createApi } from "./api/index.ts";
import { oauthCallback } from "./api/integrations.ts";
import { pairRoute } from "./api/pair.ts";
import { withBoundary } from "./boundary.ts";
import { createChats } from "./chats.ts";
import { createDeviceSessions } from "./device-sessions.ts";
import { createEventCards } from "./event-cards.ts";
import { createEventStream } from "./events.ts";
import { agentRoutes, clientRoutes, createRequestListener } from "./http.ts";
import { createHostIsolation } from "./isolation.ts";
import { openListener } from "./listener.ts";
import { runNotice } from "./run-notices.ts";
import { createTranscripts } from "./transcript.ts";
import { filesEvent, memoryEvents } from "./views.ts";
import { createWaitCards } from "./wait-cards.ts";

export interface HostServerOptions {
  /** Deployment choices parsed once at startup: the data root, where to listen and what URL users reach, and Vite. */
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
  /**
   * Channel adapters to run besides Telegram, given the function that hands an update to the host (`Channels.receive`); none when omitted.
   * Tests pass a fake channel here.
   */
  channelAdapters?: (receive: Channels["receive"]) => Channel[];
  /** The Telegram adapter's API base URL and timing; Telegram's own API with its own timing when omitted. Tests point it at a fake server. */
  telegram?: TelegramOptions;
  /** Timing of the cards sent to channels; tests set it so a send that failed is tried again soon. */
  cards?: { retryMs?: number };
  /** Timing of the notices sent to channels (failed runs, expired parks); tests set it so a send that failed is tried again soon. */
  notices?: { retryMs?: number };
  /** The clock device auth reads for pairing code expiry and human waits read for their 24-hour expiry, in epoch milliseconds; the system clock when omitted. */
  now?: () => number;
  /** How long an idle double-loop front stays open; 10 minutes when omitted. */
  frontIdleMs?: number;
  /** How often the absence check runs; an hour when omitted. */
  absenceCheckMs?: number;
}

export interface HostServer {
  /** The client listener's loopback URL: the web UI, `/api/*`, live view and `/oauth/callback`. */
  clientUrl: string;
  /** The agent listener's loopback URL: the browser endpoint, the bots endpoint, the routines endpoint and the credential exchange. */
  agentUrl: string;
  /** The origin users and OAuth providers reach. */
  publicUrl: string;
  /** The browser endpoint's token leases, so a caller can act as a bot session. */
  browser: BrowserEndpoint;
  /** The bots endpoint's token leases, so a caller can act as a bot session. */
  bots: BotsEndpoint;
  /** The routines endpoint's token leases, so a caller can act as a bot session. */
  routines: RoutinesEndpoint;
  /** Pairing codes and device tokens, so a caller can pair a device without going through the exchange. */
  devices: DeviceAuth;
  /** The channels and their links, so a caller can feed an update in or send to the linked account. */
  channels: Channels;
  currentBotId: () => string | undefined;
  /** Whether the bot is working (a turn, a busy double-loop front or a headless run): deleting it, a new session and a mode switch are refused then. */
  isWorking: (botId: string) => boolean;
  /** Whether the Claude CLI is signed in, as the last `auth status` reported; always `unknown` in local mode, which never checks. */
  signInState: () => SignInState;
  /** Closes every thread and browser, then stops listening. */
  close(): Promise<void>;
  /** Everything the host holds for a bot being deleted: its open handoffs fail, its routines, browser and credential grants go, its chat closes, and its directory moves to the trash (`bots/.trash/`). */
  removeBot(botId: string): Promise<void>;
}

/** The store `config.secrets` names; throws when the encrypted file cannot be opened with its key. */
function openSecrets({ dataRoot, secrets }: HostConfig): SecretStore {
  return secrets.backend === "file" ? openFileSecrets(dataRoot, secrets.keyFile) : keychainSecrets;
}

/** How often the absence check runs unless a test says otherwise. */
const ABSENCE_CHECK_MS = 60 * 60_000;

export async function createHostServer(o: HostServerOptions): Promise<HostServer> {
  const { cli, db } = o;
  const dataRoot = o.config.dataRoot;
  const secrets = o.secrets ?? openSecrets(o.config);
  const cwd = ensureWorkspace(dataRoot);
  const initial = o.botId ? getBot(dataRoot, o.botId) : listBots(dataRoot)[0];
  if (o.botId && !initial) throw new Error(`no bot ${o.botId} in ${dataRoot}`);
  const loop = createLoopStore(db);
  // No agent survives a host that went down, so whatever the log says still runs was cut off.
  loop.interruptRunning(Date.now());

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
  const waits = createWaits({
    db,
    emit: (botId, e) => chats.emitTo(botId, e),
    deliver: (botId, text) =>
      void chats
        .deliver(botId, text)
        .catch((e) =>
          console.error(`[waits] delivery to ${botId} failed: ${(e as Error).message}`),
        ),
    claim: (wait, text) => chats.claim(wait, text),
    alwaysAllow: (botId, tool) => allowTool(db, botId, tool, (o.now ?? Date.now)()),
    context: (botId) => {
      const bot = getBot(dataRoot, botId);
      const run = chats.runOf(botId);
      return { sessionId: run?.sessionId ?? (bot && currentSession(bot)), runId: run?.runId };
    },
    ...(o.now !== undefined && { now: o.now }),
  });
  const browser = await createBrowser({
    dataRoot,
    secrets,
    headedAllowed: o.config.headedBrowser,
    autoInstall: o.config.sidecar,
    credentials,
    tokens,
    agent: agentAt,
    bot: (botId) => getBot(dataRoot, botId),
    filesDir: (botId) => botFilesPath(dataRoot, botId),
    waits,
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
  const externalEvents = createEvents({
    db,
    secrets,
    botExists: (botId) => getBot(dataRoot, botId) !== undefined,
    relay: { configPath: o.config.relayConfig, remote: o.config.mode === "remote" },
    routeUrl: (botId) => `${clientAt.localUrl}${eventsPath(botId)}`,
    onChange: (botId, changed) => {
      chats.updateExternal(botId, changed);
      if (botId === chats.currentBotId()) broadcast(externalEvents.work(botId));
      // An item that left `open` has its card edited.
      if (changed.length > 0) void cards.sync();
    },
    onNeedsYou: () => chats.announceBots(),
    onOpened: () => void cards.sync(),
    deliver: (botId, text) =>
      void chats
        .deliver(botId, text)
        .catch((e) =>
          console.error(`[events] delivery to ${botId} failed: ${(e as Error).message}`),
        ),
  });
  const isolation = createHostIsolation({ config: o.config, sandbox });
  const hostServers: HostServersSource = (botId) =>
    combineLeases([
      browser.endpoint.lease(botId),
      handoffs.endpoint.lease(botId),
      routinesEndpoint.lease(botId),
      isolation(botId),
    ]);
  /**
   * A double-loop front only talks, hands off and manages routines: no browser, and the same isolation as the bot's own thread.
   * It is never a scheduled run, so its routines lease is attended: a routine run of the bot (headless, in a session of its own)
   * does not stop the owner creating routines from the front's chat.
   */
  const frontServers: HostServersSource = (botId) =>
    combineLeases([
      handoffs.endpoint.lease(botId),
      routinesEndpoint.lease(botId, { attended: true }),
      isolation(botId),
    ]);
  /** Other bots' directories are on every bot's deny-read list, so a bot that appears or goes reaches the open sessions. */
  const botsChanged = () => {
    if (o.config.isolateAllBots) chats.reconfigure(undefined, "bots changed");
  };
  const removeBot = async (botId: string) => {
    // Handoffs first: failing them names the bot, which needs its settings still in place.
    handoffs.removeBot(botId);
    await routines.removeBot(botId);
    // After the trash move the bot no longer exists, so messages the browser cleanup sends it (a cancelled takeover) go nowhere.
    trashBot(dataRoot, botId);
    deleteActivity(db, botId);
    deleteAllowances(db, botId);
    loop.removeBot(botId);
    await externalEvents.removeBot(botId);
    void cards.sync();
    await chats.drop(botId);
    await browser.removeBot(botId);
    // Its waits are gone with it, and so are their cards.
    void cards.sync();
    botsChanged();
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
  const transcripts = createTranscripts({
    cwd,
    dataRoot,
    db,
    handoffs,
    events: externalEvents,
    loop,
  });
  const claude = createClaudeAccess(o.config, cli);
  const chats = createChats({
    cwd,
    dataRoot,
    cli,
    claude,
    db,
    integrations,
    ...(o.frontIdleMs !== undefined && { frontIdleMs: o.frontIdleMs }),
    hostServers,
    frontServers,
    loop,
    botEnv: (botId) => externalEvents.env(botId),
    approveAll: !o.config.askApproval,
    allows: (botId, tool) => allowsTool(db, botId, tool),
    meter: createUsageMeter(db, o.now),
    handoffs,
    events: externalEvents,
    items: {
      isOpen: (botId, id) => externalEvents.isOpen(botId, id),
      acted: (botId, id, answer) => void externalEvents.answer(botId, id, answer),
    },
    transcript: (bot) => transcripts.transcript(bot),
    waits,
    routineName: (runId) => routines.nameOfRun(runId),
    routinesEvent: (botId) => routinesEvent(botId),
    workEvent: (botId) => externalEvents.work(botId),
    broadcast,
  });
  // Before the routines, adapters included: a run that ends while the host starts (a park that expired during downtime) is reported through it.
  const channels = createChannels({
    db,
    // Feature 13's absence pause counts it; until it exists, presence is not tracked.
    onActivity: () => {},
    publicUrl: clientAt.publicUrl,
    ...(o.now !== undefined && { now: o.now }),
    ...(o.notices?.retryMs !== undefined && { noticeRetryMs: o.notices.retryMs }),
  });
  const receive: Channels["receive"] = (kind, inbound) => channels.receive(kind, inbound);
  channels.register(
    createTelegramChannel({ secrets, receive, ...(o.telegram && { options: o.telegram }) }),
  );
  for (const adapter of o.channelAdapters?.(receive) ?? []) channels.register(adapter);
  const routines = createRoutines({
    db,
    dataRoot,
    execute: chats.execute,
    waits,
    notice: async (botId, text) => chats.emitTo(botId, { type: "info", text }),
    deliver: (botId, text) => chats.deliver(botId, text),
    events: externalEvents,
    onChange: (botId) => {
      if (botId === chats.currentBotId()) broadcast(routinesEvent(botId));
    },
    // The run row is the record; a notice that cannot be sent never changes it.
    onRunEnded: (end) => {
      const notice = runNotice(end);
      if (notice && getBot(dataRoot, end.routine.botId)) void channels.notify(notice);
    },
  });
  const routinesEndpoint = createRoutinesEndpoint({
    host: agentAt,
    tokens,
    routines,
    unattended: (botId) => chats.unattended(botId),
    now: Date.now,
  });
  const presence = createPresence({
    db,
    pauseAfterDays: o.config.pauseAfterAbsenceDays,
    ...(o.now !== undefined && { now: o.now }),
    ...absenceActions({
      routines,
      events: externalEvents,
      botIds: () => listBots(dataRoot).map((b) => b.id),
    }),
  });
  // A run's waits are told to the run: an answer resumes it, an expiry fails it.
  waits.subscribe((e) => {
    if (e.type === "closed") routines.waitClosed(e.wait);
    // An open wait is a Needs-you item: the sidebar and the banner follow it as it opens and closes.
    chats.announceBots();
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

  if (o.config.mode === "remote") void claude.checkSignIn();
  // Every kind has its handler by now: what a restart left unanswerable is cancelled, and overdue waits expire.
  waits.start();
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
  const cards = createCards({
    db,
    channels,
    sources: [
      createEventCards({ events: externalEvents, chats }),
      createWaitCards({ waits, chats, botName: (botId) => getBot(dataRoot, botId)?.name }),
    ],
    publicUrl: clientAt.publicUrl,
    ...(o.now !== undefined && { now: o.now }),
    ...(o.cards?.retryMs !== undefined && { retryMs: o.cards.retryMs }),
  });
  channels.handle((kind, inbound) => cards.receive(kind, inbound));
  // A newly linked account gets the cards that waited for one.
  channels.onLinked(() => void cards.sync());
  // A wait opening gets its card, and one closing any way gets its card edited.
  waits.subscribe(() => void cards.sync());
  const sessions = createDeviceSessions();
  const api = createApi({
    botsChanged,
    removeBot,
    cwd,
    headedBrowser: o.config.headedBrowser,
    pauseAfterAbsenceDays: o.config.pauseAfterAbsenceDays,
    hasActiveTasks: (botId) => loop.hasActive(botId),
    dataRoot,
    cli,
    claude,
    config: o.config,
    db,
    chats,
    browser,
    routines,
    integrations,
    credentials,
    devices,
    channels,
    sessions,
    externalEvents,
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
    externalEvents: externalEventsRoute(externalEvents),
    pair: pairRoute(devices, clientAt.publicUrl),
    api,
  });
  const agent = agentRoutes({ browser, handoffs, routines: routinesEndpoint });

  // Before the routines start, so an absence that ended while the host was down pauses them instead of catching them up.
  presence.check();
  const absenceTimer = setInterval(() => presence.check(), o.absenceCheckMs ?? ABSENCE_CHECK_MS);
  absenceTimer.unref();
  routines.start();
  channels.start();
  // Items that arrived while the host or a channel was down get their cards now.
  void cards.sync();
  handoffs.redeliverOpen();
  clientListener.serve(
    withBoundary(
      clientAt,
      devices,
      sessions,
      presence,
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
    routines: routinesEndpoint,
    devices,
    channels,
    currentBotId: chats.currentBotId,
    isWorking: (botId) => chats.isWorking(botId),
    signInState: () => claude.signInState(),
    removeBot,
    async close() {
      clientListener.pause();
      agentListener.pause();
      chats.close();
      waits.close();
      clearInterval(absenceTimer);
      await cards.stop();
      await channels.stop();
      await externalEvents.stop();
      routines.stop();
      await browser.close();
      await vite?.close();
      await Promise.all([clientListener.stop(), agentListener.stop()]);
    },
  };
}
