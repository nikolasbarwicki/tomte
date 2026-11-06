import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";
import { z } from "zod";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { getSessionInfo, getSessionMessages, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { combineLeases, type HostServersSource, type ResolvedCli } from "./harness/index.ts";
import { BROWSER_ENDPOINT_PATH, BROWSER_UI_PATHS, CREDENTIAL_EXCHANGE_PATH, LIVE_VIEW_PATH, createBrowser, type BrowserEndpoint, type BrowserRuntimeOptions, type LiveViewOptions, type SandboxStatus } from "./browser/index.ts";
import { BOTS_ENDPOINT_PATH, createHandoffs, parseMentions, withMentions, type BotsEndpoint, type Mention } from "./handoffs/index.ts";
import { TokenRegistry } from "./platform/tokens.ts";
import {
  BROWSER_FILES_DIR,
  Thread,
  botContext,
  botFilesPath,
  botMemoryPath,
  createBot,
  currentSession,
  deleteFile,
  getActivity,
  getBot,
  listBots,
  listFiles,
  markSeen,
  newSession,
  readMemory,
  recordMessage,
  resolveInside,
  reveal,
  setBrowserEnabled,
  setBrowserHeaded,
  touchBot,
  userMemoryPath,
  watchFiles,
  type TurnResult,
} from "./bots/index.ts";
import { isFace, isStroke } from "./contract/avatars.ts";
import { watchHerdr } from "./herdr.ts";
import { credentialApi, createCredentials } from "./credentials/index.ts";
import { Conflict, RoutineInput, createRoutines, headlessDelegate, runHeadless, type Executor, type RoutineJob } from "./routines/index.ts";
import { NameTaken, createIntegrations } from "./integrations/index.ts";
import { InvalidInput, NotFound } from "./platform/errors.ts";
import type { SecretStore } from "./platform/secrets.ts";
import type { Bot, BotStatus, BotsEvent, CredentialsEvent, FilesEvent, LastMessage, IntegrationsEvent, MemoryEvent, Notice, RoutinesEvent, RunTrigger, ServerEvent } from "./contract/events.ts";

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

  /** False until startup finishes; the socket opens first so the port is known, but nothing is served yet. */
  let ready = false;
  const http = createServer((req, res) => {
    if (!ready) return void res.writeHead(503).end();
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (path === "/oauth/callback" && req.method === "GET") return void oauthCallback(res, url.searchParams);
    if (path === BROWSER_ENDPOINT_PATH)
      return void browser.endpoint.handle(req, res).catch((e) => {
        console.error(`[browser] endpoint failed: ${(e as Error).message}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    if (path === BOTS_ENDPOINT_PATH)
      return void handoffs.endpoint.handle(req, res).catch((e) => {
        console.error(`[bots] endpoint failed: ${(e as Error).message}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    if (path === CREDENTIAL_EXCHANGE_PATH)
      return void browser.handleCredentialExchange(req, res).catch((e) => {
        console.error(`[browser] credential exchange failed: ${(e as Error).message}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    if (path === LIVE_VIEW_PATH)
      return void browser.handleLiveView(req, res).catch((e) => {
        console.error(`[browser] live view failed: ${(e as Error).message}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    if (BROWSER_UI_PATHS.has(path))
      return void browser.handleUi(req, res, path).catch((e) => {
        console.error(`[browser] ui route failed: ${(e as Error).message}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    if (path.startsWith("/api/"))
      return void api(req, res, path).catch((e) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(e));
      });
    if (vite) vite.middlewares(req, res);
    else res.writeHead(404).end();
  });
  const listening = Promise.withResolvers<void>();
  http.once("error", listening.reject);
  http.listen(o.port, "127.0.0.1", listening.resolve);
  await listening.promise;
  const port = (http.address() as AddressInfo).port;

  const credentials = createCredentials({ db, secrets: secrets, onChange: () => broadcast(credentialsEvent()) });
  const tokens = new TokenRegistry();
  const browser = await createBrowser({
    secrets,
    credentials,
    tokens,
    port: () => port,
    bot: (botId) => getBot(cwd, botId),
    filesDir: (botId) => botFilesPath(cwd, botId),
    unattended: (botId) => !!chats.get(botId)?.routineTurn || headlessRuns.has(botId),
    emit: (botId, e) => {
      const chat = chats.get(botId);
      if (chat) emit(chat, e);
    },
    deliver: (botId, text) => void deliver(botId, text),
    sandbox: o.sandbox,
    runtime: o.browser,
    liveView: o.liveView,
    takeoverInactivityMs: o.takeoverInactivityMs,
  });
  const handoffs = createHandoffs({
    db,
    tokens,
    port: () => port,
    show: (botId, card) => {
      const chat = chats.get(botId);
      if (chat) emit(chat, card);
    },
    cards: () => listBots(cwd).map((bot) => ({ id: bot.id, name: bot.name, description: bot.purpose, status: isWorking(bot.id) ? "working" : "idle" })),
    botName: (botId) => getBot(cwd, botId)?.name,
    filesDir: (botId) => botFilesPath(cwd, botId),
    deliver: (botId, text) =>
      void deliver(botId, text).catch((e) => console.error(`[bots] delivery to ${botId} failed: ${(e as Error).message}`)),
  });
  const hostServers: HostServersSource = (botId) => combineLeases([browser.endpoint.lease(botId), handoffs.endpoint.lease(botId)]);

  const clients = new Set<ServerResponse>();
  const broadcast = (e: ServerEvent | MemoryEvent | FilesEvent | RoutinesEvent | BotsEvent | IntegrationsEvent | CredentialsEvent) => {
    for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`);
  };

  /** A message waiting for its bot to be free. `text` is what the bot receives. A user entry also keeps what the page shows, so it can be listed and cancelled until it runs. */
  type UserEntry = { source: "user"; id: string; text: string; shown: string; mentions: Mention[] };
  type InboxEntry = { source: "host"; text: string } | UserEntry;

  /** A bot's conversation with a live thread; it exists while the bot is open or still running a turn in the background. */
  type Chat = {
    bot: Bot;
    thread: Thread;
    /** Transcript events, replayed when the page (re)connects or switches back to this bot. */
    history: ServerEvent[];
    busy: boolean;
    /** True while a routine turn runs, so its questions and approvals are answered without the user. */
    routineTurn: boolean;
    /** Questions and approvals waiting for the user, by id. */
    pending: Map<string, (value: string) => void>;
    /** Integration or bot settings changed during a turn; the thread reopens once the turn ends. */
    configStale: boolean;
    /** Messages for the bot that start the next turn once it is free: the user's sends while it was busy, and host messages (a human wait's outcome). */
    inbox: InboxEntry[];
  };
  const chats = new Map<string, Chat>();
  /** The chat shown in the UI. */
  let current: Chat | undefined;
  /** Counts switches so an earlier switch still loading its transcript does not override a later one. */
  let switches = 0;

  const emit = (chat: Chat, e: ServerEvent) => {
    chat.history.push(e);
    if (chat === current) broadcast(e);
  };

  const queuedEvent = (e: UserEntry): ServerEvent =>
    e.mentions.length ? { type: "queued", id: e.id, text: e.shown, mentions: e.mentions } : { type: "queued", id: e.id, text: e.shown };

  /** Shows a user message in the transcript and records it as the bot's latest; called when it reaches the bot. */
  function userSaid(chat: Chat, text: string, mentions: Mention[]) {
    emit(chat, mentions.length ? { type: "user", text, mentions } : { type: "user", text });
    recordMessage(db, chat.bot.id, { from: "user", text, at: Date.now() });
  }

  /** Closes a chat that is neither shown nor running; its session resumes from disk when the bot is opened again. */
  function release(chat: Chat) {
    if (chat === current || chat.busy || chat.inbox.length) return;
    chat.thread.close("released");
    chats.delete(chat.bot.id);
  }
  const memoryEvents = (): MemoryEvent[] => [
    { type: "memory", scope: "user", text: readMemory(userMemoryPath()) },
    { type: "memory", scope: "bot", text: current ? readMemory(botMemoryPath(cwd, current.bot.id)) : "" },
  ];

  const filesEvent = (): FilesEvent => {
    const dir = current ? botFilesPath(cwd, current.bot.id) : "";
    return { type: "files", dir, files: dir ? listFiles(dir).filter((f) => !f.path.startsWith(`${BROWSER_FILES_DIR}/`)) : [] };
  };
  /** Pushes the open bot's file list to the page whenever its folder changes. */
  let filesWatcher: FSWatcher | undefined;

  /** Recent notices, replayed on connect but kept out of the chat transcript. */
  const notices: Notice[] = [];
  /** Notices not yet narrated by a bot; drained as one turn whenever a bot is open and idle. */
  let unspoken: Notice[] = [];
  const notify = (source: string, title: string, body = "") => {
    const n: Notice = { type: "notify", source, title, body, at: Date.now() };
    notices.push(n);
    if (notices.length > 50) notices.shift();
    broadcast(n);
    unspoken.push(n);
    void drain();
  };

  /** A routine turn waiting for its bot; it runs in the bot's chat once that is idle, or headless if the bot has no chat. */
  type QueuedRoutine = { job: RoutineJob; resolve(text: string): void; reject(e: Error): void; stop?: (reason: string) => void };
  let routineQueue: QueuedRoutine[] = [];
  /** Bots whose session a headless routine is writing; their chat must not start its own turn meanwhile. */
  const headlessRuns = new Map<string, string>();

  const execute: Executor = (job) => {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const item: QueuedRoutine = { job, resolve, reject };
    routineQueue.push(item);
    void drain();
    return {
      done: promise,
      stop: (reason) => {
        if (item.stop) return item.stop(reason);
        routineQueue = routineQueue.filter((i) => i !== item);
        reject(new Error(reason));
      },
    };
  };

  function startHeadless(item: QueuedRoutine) {
    const { bot, routine } = item.job;
    const h = runHeadless(cwd, cli, integrations, hostServers, item.job);
    item.stop = h.stop;
    headlessRuns.set(bot.id, routine.name);
    announceBots();
    h.done
      .then((text) => {
        if (text.trim()) recordMessage(db, bot.id, { from: "bot", text, at: Date.now() });
        item.resolve(text);
      }, item.reject)
      .finally(() => {
        headlessRuns.delete(bot.id);
        announceBots();
        // Reload the bot's chat so the routine's turn shows up in its transcript.
        const chat = chats.get(bot.id);
        if (chat && !chat.busy) void reload(chat);
        else void drain();
      });
  }

  /** Starts every routine turn whose bot is free, then narrates pending notices in the open chat. */
  async function drain() {
    for (const item of routineQueue) {
      const botId = item.job.bot.id;
      const chat = chats.get(botId);
      if (headlessRuns.has(botId) || chat?.busy) continue;
      routineQueue = routineQueue.filter((i) => i !== item);
      if (chat) void runRoutine(chat, item);
      else startHeadless(item);
    }
    for (const chat of chats.values()) {
      if (!chat.inbox.length || chat.busy || headlessRuns.has(chat.bot.id)) continue;
      const entries = chat.inbox.splice(0);
      for (const e of entries) {
        if (e.source === "user") {
          emit(chat, { type: "dequeued", id: e.id });
          userSaid(chat, e.shown, e.mentions);
        } else for (const card of handoffs.receivedCards(e.text, chat.bot.id)) emit(chat, card);
      }
      void turn(chat, entries.map((e) => e.text).join("\n\n"));
    }
    if (current) await narrate(current);
  }

  /** Sends a host message into a bot's session: queued while the bot is busy, and the session reopens if it is closed. */
  async function deliver(botId: string, text: string) {
    const bot = getBot(cwd, botId);
    if (!bot) return;
    let chat = chats.get(botId);
    if (!chat) {
      const t = await transcript(bot);
      chat = chats.get(botId) ?? createChat(bot, t);
    }
    chat.inbox.push({ source: "host", text });
    await drain();
  }

  async function runRoutine(chat: Chat, item: QueuedRoutine) {
    item.stop = (reason) => chat.thread.close(reason);
    emit(chat, { type: "routine", name: item.job.routine.name, trigger: item.job.prompt.includes('trigger="manual"') ? "manual" : "schedule" });
    chat.routineTurn = true;
    const r = await turn(chat, item.job.prompt);
    r instanceof Error ? item.reject(r) : item.resolve(r.text);
  }

  const routines = createRoutines({
    db,
    cwd,
    execute,
    onChange: (botId) => {
      if (botId === current?.bot.id) broadcast(routinesEvent(current));
    },
  });
  const integrations = createIntegrations({
    db,
    hostDir: join(cwd, ".host"),
    secrets: secrets,
    oauthRedirectUrl: `http://127.0.0.1:${port}/oauth/callback`,
    onChange: () => {
      broadcast(integrationsEvent());
      for (const chat of chats.values()) {
        if (chat.busy) chat.configStale = true;
        else chat.thread.close("integrations changed");
      }
    },
  });
  const integrationsEvent = (): IntegrationsEvent => ({ type: "integrations", integrations: integrations.list() });
  const credentialsEvent = (): CredentialsEvent => ({ type: "credentials", credentials: credentials.list() });
  const routinesEvent = (chat: Chat): RoutinesEvent => ({ type: "routines", botId: chat.bot.id, routines: routines.list(chat.bot.id) });

  const isWorking = (botId: string) => !!chats.get(botId)?.busy || headlessRuns.has(botId);

  const botsEvent = (): BotsEvent => ({
    type: "bots",
    bots: listBots(cwd).map((bot) => {
      const activity = getActivity(db, bot.id);
      const last = activity?.last ?? null;
      const status: BotStatus =
        isWorking(bot.id)
          ? "working"
          : last?.from === "bot" && last.at > (activity?.seenAt ?? 0)
            ? "unseen"
            : "idle";
      return { ...bot, last, status };
    }),
  });
  const announceBots = () => broadcast(botsEvent());

  const stopHerdr = !o.herdr ? undefined : watchHerdr((title, body) => notify("herdr", title, body), (l) => console.error(l));

  async function narrate(chat: Chat) {
    if (chat.busy || headlessRuns.has(chat.bot.id) || !unspoken.length) return;
    const batch = unspoken;
    unspoken = [];
    const lines = batch.map((n) => `- [${n.source}] ${n.title}${n.body ? ` — ${n.body}` : ""}`).join("\n");
    emit(chat, { type: "update", text: batch.map((n) => n.title).join(" · ") });
    await turn(
      chat,
      `<external-update>\nThese updates arrived from other coding agents (via herdr/omp), not from the user:\n${lines}\n` +
        `Tell the user about them in one or two natural sentences. If an agent needs input, read its pane with herdr first and say what it is asking; do not send it input unless the user tells you to.\n</external-update>`,
    );
  }

  /** Runs one turn in a chat, shown or not; failures are shown there and returned. */
  async function turn(chat: Chat, text: string): Promise<TurnResult | Error> {
    chat.busy = true;
    handoffs.startDelivered(text);
    touchBot(cwd, chat.bot);
    announceBots();
    let out: TurnResult | Error;
    try {
      out = await chat.thread.send(text, (m) => {
        if (m.type === "system" && m.subtype === "compact_boundary")
          emit(chat, { type: "compacted", trigger: m.compact_metadata.trigger, preTokens: m.compact_metadata.pre_tokens });
        if (m.type === "assistant")
          for (const blk of m.message.content) if (blk.type === "tool_use") emit(chat, { type: "tool", name: blk.name, input: JSON.stringify(blk.input) });
        if (m.type !== "stream_event" || m.parent_tool_use_id) return;
        const ev = m.event;
        if (ev.type === "content_block_start" && ev.content_block.type === "text") emit(chat, { type: "text_start" });
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") emit(chat, { type: "delta", text: ev.delta.text });
      });
      emit(chat, { type: "done" });
      if (out.text.trim()) recordMessage(db, chat.bot.id, { from: "bot", text: out.text, at: Date.now() });
      const usage = await chat.thread.contextUsage().catch((e) => console.error(`[host] context usage failed: ${(e as Error).message}`));
      if (usage) emit(chat, { type: "context", ...usage });
    } catch (e) {
      out = e as Error;
      emit(chat, { type: "error", message: out.message });
    } finally {
      chat.busy = false;
      chat.routineTurn = false;
      if (chat.configStale) {
        chat.configStale = false;
        chat.thread.close("integrations changed");
      }
      announceBots();
    }
    release(chat);
    void drain();
    return out;
  }

  const waitForUser = (chat: Chat, event: (id: string) => ServerEvent) => {
    const id = randomUUID();
    const { promise, resolve } = Promise.withResolvers<string>();
    chat.pending.set(id, resolve);
    emit(chat, event(id));
    return promise;
  };

  /** `chat` is read lazily: the thread is created while its chat is being built. */
  function openThread(bot: Bot, resume: boolean, chat: () => Chat): Thread {
    return new Thread({
      cli,
      cwd,
      ...botContext(cwd, bot),
      resume,
      idleMs: 10 * 60_000,
      approveAll: process.env.CLAUDEBOT_ASK_APPROVAL !== "1",
      integrations,
      hostServers: () => hostServers(bot.id),
      log: (l) => console.error(l),
      onMemory: (scope, text) => {
        if (scope === "user" || current?.bot.id === bot.id) broadcast({ type: "memory", scope, text });
      },
      delegate: {
        askUser: (question) =>
          chat().routineTurn ? headlessDelegate.askUser(question) : waitForUser(chat(), (id) => ({ type: "ask", id, question })),
        approve: async (tool, input, reason): Promise<PermissionResult> => {
          if (chat().routineTurn) return headlessDelegate.approve(tool, input, reason);
          const v = await waitForUser(chat(), (id) => ({ type: "approve", id, tool, reason, input: JSON.stringify(input, null, 2) }));
          return v === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "user declined" };
        },
      },
    });
  }

  const ROUTINE_TAG = /^<scheduled-routine name="([^"]*)" trigger="(schedule|manual)"/;

  /** Rebuild the UI transcript of a bot's session from Claude Code's own session file. */
  async function replay(sessionId: string, ownerId: string): Promise<ServerEvent[]> {
    const out: ServerEvent[] = [];
    for (const m of await getSessionMessages(sessionId, { dir: cwd })) {
      const msg = m.message;
      const content = msg && typeof msg === "object" && "content" in msg ? msg.content : undefined;
      if (m.parent_tool_use_id) continue;
      if (m.type === "user") {
        const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.flatMap((b) => (b.type === "text" ? [b.text] : [])) : [];
        for (const text of texts) {
          const routine = text.match(ROUTINE_TAG);
          if (routine) out.push({ type: "routine", name: routine[1], trigger: routine[2] as RunTrigger });
          else if (/^<handoff(-update)? /.test(text)) out.push(...handoffs.receivedCards(text, ownerId));
          else if (!text.startsWith("<") || text.startsWith("<mention ")) {
            const { text: typed, mentions } = parseMentions(text);
            out.push(mentions.length ? { type: "user", text: typed, mentions } : { type: "user", text });
          }
        }
      } else if (m.type === "assistant" && Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "text") out.push({ type: "text_start" }, { type: "delta", text: b.text });
          if (b.type === "tool_use") out.push({ type: "tool", name: b.name, input: JSON.stringify(b.input) }, ...handoffs.sentCards(b.name, b.input as Record<string, string>, ownerId));
        }
      }
    }
    if (out.length) out.push({ type: "done" });
    return out;
  }

  /** Seeds sidebar activity for bots that predate it, from their newest session with chat messages; counts it as seen. */
  async function backfillActivity() {
    for (const bot of listBots(cwd)) {
      if (getActivity(db, bot.id)) continue;
      for (const id of [...bot.sessions].reverse()) {
        const info = await getSessionInfo(id, { dir: cwd });
        if (!info) continue;
        let last: LastMessage | undefined;
        for (const e of await replay(id, bot.id)) {
          if (e.type === "user") last = { from: "user", text: e.text, at: info.lastModified };
          if (e.type === "delta") last = { from: "bot", text: e.text, at: info.lastModified };
        }
        if (!last) continue;
        recordMessage(db, bot.id, last);
        markSeen(db, bot.id, last.at);
        break;
      }
    }
  }

  type Transcript = { history: ServerEvent[]; hasSession: boolean };

  /** Reads a bot's whole transcript, across its sessions, from Claude Code's session files. */
  async function transcript(bot: Bot): Promise<Transcript> {
    // getSessionInfo has no summary for a session whose first message is a host tag (<handoff>, <scheduled-routine>), so fall back to its messages.
    const current = currentSession(bot);
    const hasSession = !!(await getSessionInfo(current, { dir: cwd })) || (await getSessionMessages(current, { dir: cwd })).length > 0;
    const history: ServerEvent[] = [];
    for (const [i, id] of bot.sessions.entries()) {
      if (i > 0) history.push({ type: "session" });
      if (i < bot.sessions.length - 1 || hasSession) history.push(...(await replay(id, bot.id)));
    }
    return { history, hasSession };
  }

  function createChat(bot: Bot, { history, hasSession }: Transcript, inbox: InboxEntry[] = []): Chat {
    history.push(...browser.pendingWaits(bot.id));
    const headless = headlessRuns.get(bot.id);
    if (headless) history.push({ type: "info", text: `routine "${headless}" is running in the background; its reply appears here when it finishes` });
    for (const e of inbox) if (e.source === "user") history.push(queuedEvent(e));
    const chat: Chat = { bot, history, busy: false, routineTurn: false, pending: new Map(), configStale: false, inbox, thread: openThread(bot, hasSession, () => chat) };
    chats.set(bot.id, chat);
    return chat;
  }

  /** Sends the page everything about the chat it now shows. */
  function show(chat: Chat) {
    broadcast({ type: "reset", botId: chat.bot.id });
    for (const e of chat.history) broadcast(e);
    announceBots();
    for (const e of memoryEvents()) broadcast(e);
    filesWatcher?.close();
    filesWatcher = watchFiles(botFilesPath(cwd, chat.bot.id), () => broadcast(filesEvent()));
    broadcast(filesEvent());
    broadcast(routinesEvent(chat));
  }

  /** Shows the bot's chat; a chat still running in the background is shown as it is, live. */
  async function switchTo(bot: Bot) {
    const n = ++switches;
    let chat = chats.get(bot.id);
    if (!chat) {
      const t = await transcript(bot);
      if (n !== switches) return;
      chat = chats.get(bot.id) ?? createChat(bot, t);
    }
    const previous = current;
    current = chat;
    if (previous) release(previous);
    show(chat);
    void drain();
  }

  /** Rebuilds an idle chat from disk once a headless routine has written its session. */
  async function reload(old: Chat) {
    const t = await transcript(old.bot);
    if (chats.get(old.bot.id) === old && !old.busy) {
      old.thread.close("reload");
      const chat = createChat(old.bot, t, old.inbox);
      if (current === old) {
        current = chat;
        show(chat);
      }
    }
    void drain();
  }

  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let s = "";
    for await (const chunk of req) s += chunk;
    return s ? JSON.parse(s) : {};
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    if (path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const open = current ? [routinesEvent(current), { type: "reset", botId: current.bot.id }, ...current.history] : [];
      for (const e of [botsEvent(), integrationsEvent(), credentialsEvent(), ...memoryEvents(), filesEvent(), ...notices, ...open]) res.write(`data: ${JSON.stringify(e)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const b = await body(req);
    if (path.startsWith("/api/routines/")) return routineApi(res, path, b);
    if (path.startsWith("/api/integrations/")) return integrationApi(res, path, b);
    if (path.startsWith("/api/credentials/")) {
      const r = await credentialApi(credentials, path, b);
      return r ? json(res, r.body, r.status) : void res.writeHead(404).end();
    }
    const str = (key: string) => (typeof b[key] === "string" ? (b[key] as string) : "");
    switch (path) {
      case "/api/info":
        return json(res, { cwd, cli: `${cli.path} (${cli.source})`, auth: process.env.ANTHROPIC_API_KEY ? "api key" : "CLI stored login", browser: browser.status() });
      case "/api/seen": {
        const bot = getBot(cwd, str("botId"));
        if (!bot) return json(res, { error: "no such bot" }, 404);
        markSeen(db, bot.id, Date.now());
        announceBots();
        return json(res, { ok: true });
      }
      case "/api/bots/new": {
        if (!str("name").trim()) return json(res, { error: "name required" }, 400);
        const face = str("face");
        const stroke = str("stroke");
        if (!isFace(face) || !isStroke(stroke)) return json(res, { error: "unknown avatar face or stroke color" }, 400);
        const bot = createBot(cwd, str("name"), str("purpose"), undefined, { face, stroke });
        await switchTo(bot);
        return json(res, bot);
      }
      case "/api/bots/browser": {
        const bot = getBot(cwd, str("botId"));
        if (!bot) return json(res, { error: "no such bot" }, 404);
        if (typeof b.enabled !== "boolean") return json(res, { error: "enabled must be true or false" }, 400);
        const engine = browser.status();
        if (b.enabled && engine.status === "unavailable") return json(res, { error: engine.reason }, 409);
        setBrowserEnabled(cwd, bot.id, b.enabled);
        const chat = chats.get(bot.id);
        if (chat?.busy) chat.configStale = true;
        else chat?.thread.close("browser setting changed");
        announceBots();
        return json(res, { ok: true });
      }
      case "/api/bots/browser/headed": {
        const bot = getBot(cwd, str("botId"));
        if (!bot) return json(res, { error: "no such bot" }, 404);
        if (typeof b.headed !== "boolean") return json(res, { error: "headed must be true or false" }, 400);
        setBrowserHeaded(cwd, bot.id, b.headed);
        // The window is chosen when the engine launches Chrome, so a running browser must restart to pick it up.
        await browser.restart(bot.id);
        announceBots();
        return json(res, { ok: true });
      }
      case "/api/bots/browser/restart":
      case "/api/bots/browser/sign-out": {
        const bot = getBot(cwd, str("botId"));
        if (!bot) return json(res, { error: "no such bot" }, 404);
        if (path.endsWith("/sign-out")) await browser.signOut(bot.id);
        else await browser.restart(bot.id);
        return json(res, { ok: true });
      }
      case "/api/open": {
        const bot = getBot(cwd, str("botId"));
        if (!bot) return json(res, { error: "no such bot" }, 404);
        if (bot.id !== current?.bot.id) await switchTo(bot);
        return json(res, bot);
      }
    }
    if (!current) return json(res, { error: "no bot open; create one first" }, 409);
    const chat = current;
    switch (path) {
      case "/api/send": {
        const ids = Array.isArray(b.mentions) ? b.mentions : [];
        const mentions: Mention[] = [];
        for (const id of ids) {
          const target = typeof id === "string" && id !== chat.bot.id ? getBot(cwd, id) : undefined;
          if (!target) return json(res, { error: `cannot mention ${typeof id === "string" ? id : "that"}: unknown bot or the open bot` }, 400);
          if (!mentions.some((m) => m.id === target.id)) mentions.push({ id: target.id, name: target.name });
        }
        const text = withMentions(str("text"), mentions);
        if (chat.busy || headlessRuns.has(chat.bot.id)) {
          const entry: UserEntry = { source: "user", id: randomUUID(), text, shown: str("text"), mentions };
          chat.inbox.push(entry);
          emit(chat, queuedEvent(entry));
          return json(res, { ok: true, queued: entry.id });
        }
        userSaid(chat, str("text"), mentions);
        json(res, { ok: true });
        void turn(chat, text);
        return;
      }
      case "/api/send/cancel": {
        for (const c of chats.values()) {
          const i = c.inbox.findIndex((e) => e.source === "user" && e.id === str("id"));
          if (i < 0) continue;
          c.inbox.splice(i, 1);
          emit(c, { type: "dequeued", id: str("id") });
          return json(res, { ok: true });
        }
        return json(res, { error: "that message already reached the bot" }, 404);
      }
      case "/api/answer": {
        for (const c of chats.values()) {
          const resolve = c.pending.get(str("id"));
          if (!resolve) continue;
          c.pending.delete(str("id"));
          resolve(str("value"));
          emit(c, { type: "answered", id: str("id"), value: str("value") });
          return json(res, { ok: true });
        }
        return json(res, { error: "no such question" }, 404);
      }
      case "/api/model":
        await chat.thread.setModel(str("model"));
        emit(chat, { type: "info", text: `model → ${str("model")}` });
        return json(res, { ok: true });
      case "/api/effort":
        await chat.thread.setEffort(str("effort") as Parameters<Thread["setEffort"]>[0]);
        emit(chat, { type: "info", text: `effort → ${str("effort")}` });
        return json(res, { ok: true });
      case "/api/session/new": {
        if (chat.busy || headlessRuns.has(chat.bot.id)) return json(res, { error: "a turn is running; wait for it to finish" }, 409);
        chat.thread.close("new session");
        newSession(cwd, chat.bot);
        chat.thread = openThread(chat.bot, false, () => chat);
        emit(chat, { type: "session" });
        browser.cancelTakeover(chat.bot.id, "a new session started");
        return json(res, { ok: true });
      }
      case "/api/files/delete": {
        if (!deleteFile(botFilesPath(cwd, chat.bot.id), str("path"))) return json(res, { error: "no such file" }, 404);
        return json(res, { ok: true });
      }
      case "/api/files/reveal": {
        const dir = botFilesPath(cwd, chat.bot.id);
        const target = str("path") ? resolveInside(dir, str("path")) : dir;
        if (!target || !existsSync(target)) return json(res, { error: "no such file" }, 404);
        reveal(target, (l) => console.error(l));
        return json(res, { ok: true });
      }
      case "/api/notify":
        if (!str("title")) return json(res, { error: "title required" }, 400);
        notify(str("source") || "external", str("title"), str("body"));
        return json(res, { ok: true });
    }
    res.writeHead(404).end();
  }

  const Id = z.object({ id: z.string() });
  const RoutineCreate = RoutineInput.extend({ botId: z.string() });
  const RoutinePatch = RoutineInput.partial().extend({ id: z.string() });
  const RunsQuery = Id.extend({ before: z.number().optional(), limit: z.number().int().optional() });
  const Preview = z.object({ schedule: RoutineInput.shape.schedule });

  /** Routine routes address bots and routines by id, so they work whichever bot is open. */
  async function routineApi(res: ServerResponse, path: string, b: Record<string, unknown>) {
    try {
      switch (path) {
        case "/api/routines/list": {
          const { botId } = z.object({ botId: z.string() }).parse(b);
          if (!getBot(cwd, botId)) throw new NotFound("no such bot");
          return json(res, routines.list(botId));
        }
        case "/api/routines/create": {
          const { botId, ...input } = RoutineCreate.parse(b);
          return json(res, routines.create(botId, input));
        }
        case "/api/routines/update": {
          const { id, ...patch } = RoutinePatch.parse(b);
          return json(res, routines.update(id, patch));
        }
        case "/api/routines/delete":
          await routines.remove(Id.parse(b).id);
          return json(res, { ok: true });
        case "/api/routines/run":
          return json(res, routines.testRun(Id.parse(b).id));
        case "/api/routines/runs": {
          const q = RunsQuery.parse(b);
          return json(res, routines.runs(q.id, q.before, q.limit));
        }
        case "/api/routines/preview":
          return json(res, { next: routines.preview(Preview.parse(b).schedule) });
      }
      res.writeHead(404).end();
    } catch (e) {
      if (e instanceof z.ZodError) return json(res, { error: e.issues.map((i) => i.message).join("; ") }, 400);
      if (e instanceof Conflict) return json(res, { error: e.message }, 409);
      if (e instanceof NotFound) return json(res, { error: e.message }, 404);
      throw e;
    }
  }

  const CustomIntegration = z.discriminatedUnion("transport", [
    z.object({ name: z.string().trim(), url: z.string().trim(), transport: z.enum(["http", "sse"]), token: z.string().optional(), oauth: z.boolean().optional(), skillsDir: z.string().optional() }),
    z.object({ name: z.string().trim(), transport: z.literal("stdio"), command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), skillsDir: z.string().optional() }),
  ]);

  async function integrationApi(res: ServerResponse, path: string, b: Record<string, unknown>) {
    try {
      switch (path) {
        case "/api/integrations/list":
          return json(res, integrations.list());
        case "/api/integrations/add-custom":
          return json(res, await integrations.addCustom(CustomIntegration.parse(b)));
        case "/api/integrations/set-bearer": {
          const { id, token } = z.object({ id: z.string(), token: z.string() }).parse(b);
          return json(res, await integrations.setBearer(id, token));
        }
        case "/api/integrations/connect-oauth": {
          const a = Id.extend({ clientId: z.string().optional(), clientSecret: z.string().optional() }).parse(b);
          const own = a.clientId === undefined && a.clientSecret === undefined ? undefined : { clientId: a.clientId ?? "", clientSecret: a.clientSecret ?? "" };
          return json(res, await integrations.connectOAuth(a.id, own));
        }
        case "/api/integrations/disconnect":
          await integrations.disconnect(Id.parse(b).id);
          return json(res, { ok: true });
        case "/api/integrations/probe":
          return json(res, await integrations.probe(Id.parse(b).id));
        case "/api/integrations/remove":
          await integrations.remove(Id.parse(b).id);
          return json(res, { ok: true });
        case "/api/integrations/set-enabled": {
          const a = Id.extend({ enabled: z.boolean() }).parse(b);
          integrations.setEnabled(a.id, a.enabled);
          return json(res, { ok: true });
        }
        case "/api/integrations/set-policy": {
          const a = Id.extend({ tool: z.string(), policy: z.enum(["off", "ask", "auto"]) }).parse(b);
          integrations.setPolicy(a.id, a.tool, a.policy);
          return json(res, { ok: true });
        }
        case "/api/integrations/set-skill-enabled": {
          const a = Id.extend({ skill: z.string(), enabled: z.boolean() }).parse(b);
          integrations.setSkillEnabled(a.id, a.skill, a.enabled);
          return json(res, { ok: true });
        }
        case "/api/integrations/reset-policies":
          integrations.resetPolicies(Id.parse(b).id);
          return json(res, { ok: true });
      }
      res.writeHead(404).end();
    } catch (e) {
      if (e instanceof z.ZodError) return json(res, { error: e.issues.map((i) => i.message).join("; ") }, 400);
      if (e instanceof InvalidInput) return json(res, { error: e.message }, 400);
      if (e instanceof NameTaken) return json(res, { error: e.message }, 409);
      if (e instanceof NotFound) return json(res, { error: e.message }, 404);
      throw e;
    }
  }

  function json(res: ServerResponse, v: unknown, status = 200) {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
  }

  if (initial) await switchTo(initial);
  void backfillActivity()
    .then(announceBots)
    .catch((e) => console.error(`[host] activity backfill failed: ${(e as Error).message}`));

  const htmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  function page(res: ServerResponse, status: number, message: string) {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>Claudebot</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto"><p>${htmlEscape(message)}</p>`);
  }

  /** The provider sends the browser back here after sign-in. */
  async function oauthCallback(res: ServerResponse, q: URLSearchParams) {
    try {
      const i = await integrations.finishOAuth(q.get("state") ?? "", { code: q.get("code") ?? undefined, error: q.get("error") ?? undefined });
      if (i.state !== "connected") return page(res, 400, `Could not connect ${i.label}: ${i.error}`);
      page(res, 200, "Connected. You can close this tab.");
    } catch (e) {
      if (e instanceof InvalidInput || e instanceof NotFound) return page(res, 400, e.message);
      page(res, 500, (e as Error).message);
    }
  }

  const webRoot = fileURLToPath(new URL("../web", import.meta.url));
  const vite = o.vite
    ? await createVite({
        root: webRoot,
        plugins: [react(), tailwindcss()],
        resolve: { alias: { "@": webRoot } },
        server: { middlewareMode: true, hmr: { server: http } },
        appType: "spa",
      })
    : undefined;

  routines.start();
  handoffs.redeliverOpen();
  ready = true;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    browser: browser.endpoint,
    bots: handoffs.endpoint,
    currentBotId: () => current?.bot.id,
    async removeBot(botId) {
      await browser.removeBot(botId);
      handoffs.removeBot(botId);
    },
    async close() {
      ready = false;
      for (const chat of chats.values()) chat.thread.close("shutdown");
      stopHerdr?.();
      filesWatcher?.close();
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
