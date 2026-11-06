import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { FSWatcher } from "node:fs";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { botFilesPath, getBot, newSession, recordMessage, touchBot, watchFiles, type Thread, type TurnResult } from "../bots/index.ts";
import type { Handoffs, Mention } from "../handoffs/index.ts";
import type { Executor } from "../routines/index.ts";
import type { Bot, BotsEvent, Notice, RoutinesEvent, ServerEvent } from "../contract/events.ts";
import type { HostEvent } from "./events.ts";
import { createNotices } from "./notices.ts";
import { createRoutineTurns } from "./routine-turns.ts";
import { openBotThread, type ThreadEnv } from "./threads.ts";
import type { Transcript } from "./transcript.ts";
import { botsEvent, filesEvent, memoryEvents } from "./views.ts";

export interface ChatsDeps extends ThreadEnv {
  db: Database;
  handoffs: Pick<Handoffs, "receivedCards" | "startDelivered">;
  transcript(bot: Bot): Promise<Transcript>;
  /** Human-wait cards still open for a bot, replayed into a rebuilt chat. */
  pendingWaits(botId: string): ServerEvent[];
  routinesEvent(botId: string): RoutinesEvent;
  broadcast(e: HostEvent): void;
}

/** The chat the page shows, with what the user can do in it. */
export interface OpenChat {
  bot: Bot;
  /** Queues the user's message while the bot is busy, returning the entry's id; otherwise shows it and returns `start` to run the turn, so the caller can reply first. */
  send(text: string, shown: string, mentions: Mention[]): { queued: string } | { start(): void };
  setModel(model: string): Promise<void>;
  setEffort(effort: EffortLevel): Promise<void>;
  /** Starts a new session; false while a turn is running. */
  newSession(): boolean;
}

export interface Chats {
  /** Runs a routine turn in its bot's chat once the bot is free, or headless when the bot has no chat. */
  execute: Executor;
  /** Sends a host message into a bot's session: queued while the bot is busy, and the session reopens if it is closed. */
  deliver(botId: string, text: string): Promise<void>;
  /** Shows a notice to the page and has the open bot narrate it. */
  notify(source: string, title: string, body?: string): void;
  /** Shows an event in a bot's chat if it has one. */
  emitTo(botId: string, e: ServerEvent): void;
  isWorking(botId: string): boolean;
  /** True while no human is watching the bot's turn: a routine turn or a headless run. */
  unattended(botId: string): boolean;
  botsEvent(): BotsEvent;
  currentBotId(): string | undefined;
  announceBots(): void;
  open(): OpenChat | undefined;
  /** Shows the bot's chat; a chat still running in the background is shown as it is, live. */
  switchTo(bot: Bot): Promise<void>;
  /** Answers a question or approval; false when there is no such question. */
  answer(id: string, value: string): boolean;
  /** Takes back a queued user message; false when it already reached the bot. */
  cancelQueued(id: string): boolean;
  /** Reopens a bot's thread, or every bot's, to pick up changed settings; a busy chat reopens after its turn. */
  reconfigure(botId: string | undefined, reason: string): void;
  /** Recent notices, replayed on connect. */
  notices(): Notice[];
  /** The open chat's routines, reset marker and transcript, replayed on connect. */
  replayOpen(): HostEvent[];
  close(): void;
}

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

export function createChats(deps: ChatsDeps): Chats {
  const { cwd, db, broadcast } = deps;
  const chats = new Map<string, Chat>();
  /** The chat shown in the UI. */
  let current: Chat | undefined;
  /** Counts switches so an earlier switch still loading its transcript does not override a later one. */
  let switches = 0;
  /** Pushes the open bot's file list to the page whenever its folder changes. */
  let filesWatcher: FSWatcher | undefined;
  const notices = createNotices({ broadcast, wake: () => void drain() });
  const routineTurns = createRoutineTurns({
    ...deps,
    announceBots: () => announceBots(),
    // Reload the bot's chat so the routine's turn shows up in its transcript.
    headlessDone(botId) {
      const chat = chats.get(botId);
      if (chat && !chat.busy) void reload(chat);
      else void drain();
    },
    wake: () => void drain(),
  });
  const headless = (botId: string) => routineTurns.headless(botId) !== undefined;

  const emit = (chat: Chat, e: ServerEvent) => {
    chat.history.push(e);
    if (chat === current) broadcast(e);
  };
  const isWorking = (botId: string) => !!chats.get(botId)?.busy || headless(botId);
  const announceBots = () => broadcast(botsEvent(cwd, db, isWorking));

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

  /** Starts every routine turn whose bot is free, then narrates pending notices in the open chat. */
  async function drain() {
    routineTurns.startReady(
      (botId) => chats.get(botId),
      (chat, job) => {
        emit(chat, { type: "routine", name: job.routine.name, trigger: job.prompt.includes('trigger="manual"') ? "manual" : "schedule" });
        chat.routineTurn = true;
        return { done: turn(chat, job.prompt), stop: (reason) => chat.thread.close(reason) };
      },
    );
    for (const chat of chats.values()) {
      if (!chat.inbox.length || chat.busy || headless(chat.bot.id)) continue;
      const entries = chat.inbox.splice(0);
      for (const e of entries) {
        if (e.source === "user") {
          emit(chat, { type: "dequeued", id: e.id });
          userSaid(chat, e.shown, e.mentions);
        } else for (const card of deps.handoffs.receivedCards(e.text, chat.bot.id)) emit(chat, card);
      }
      void turn(chat, entries.map((e) => e.text).join("\n\n"));
    }
    if (current) await narrate(current);
  }

  async function deliver(botId: string, text: string) {
    const bot = getBot(cwd, botId);
    if (!bot) return;
    let chat = chats.get(botId);
    if (!chat) {
      const t = await deps.transcript(bot);
      chat = chats.get(botId) ?? createChat(bot, t);
    }
    chat.inbox.push({ source: "host", text });
    await drain();
  }

  /** Has the open bot tell the user about notices it has not narrated yet. */
  async function narrate(chat: Chat) {
    if (chat.busy || headless(chat.bot.id)) return;
    const n = notices.takeUnspoken();
    if (!n) return;
    emit(chat, { type: "update", text: n.update });
    await turn(chat, n.prompt);
  }

  /** Runs one turn in a chat, shown or not; failures are shown there and returned. */
  async function turn(chat: Chat, text: string): Promise<TurnResult | Error> {
    chat.busy = true;
    deps.handoffs.startDelivered(text);
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
  const openThread = (bot: Bot, resume: boolean, chat: () => Chat): Thread =>
    openBotThread(deps, bot, resume, {
      onMemory: (scope, text) => {
        if (scope === "user" || current?.bot.id === bot.id) broadcast({ type: "memory", scope, text });
      },
      unattended: () => chat().routineTurn,
      ask: (event) => waitForUser(chat(), event),
    });

  function createChat(bot: Bot, { history, hasSession }: Transcript, inbox: InboxEntry[] = []): Chat {
    history.push(...deps.pendingWaits(bot.id));
    const routine = routineTurns.headless(bot.id);
    if (routine) history.push({ type: "info", text: `routine "${routine}" is running in the background; its reply appears here when it finishes` });
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
    for (const e of memoryEvents(cwd, chat.bot.id)) broadcast(e);
    filesWatcher?.close();
    filesWatcher = watchFiles(botFilesPath(cwd, chat.bot.id), () => broadcast(filesEvent(cwd, current?.bot.id)));
    broadcast(filesEvent(cwd, chat.bot.id));
    broadcast(deps.routinesEvent(chat.bot.id));
  }

  async function switchTo(bot: Bot) {
    const n = ++switches;
    let chat = chats.get(bot.id);
    if (!chat) {
      const t = await deps.transcript(bot);
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
    const t = await deps.transcript(old.bot);
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

  function openChat(chat: Chat): OpenChat {
    return {
      bot: chat.bot,
      send(text, shown, mentions) {
        if (chat.busy || headless(chat.bot.id)) {
          const entry: UserEntry = { source: "user", id: randomUUID(), text, shown, mentions };
          chat.inbox.push(entry);
          emit(chat, queuedEvent(entry));
          return { queued: entry.id };
        }
        userSaid(chat, shown, mentions);
        return { start: () => void turn(chat, text) };
      },
      async setModel(model) {
        await chat.thread.setModel(model);
        emit(chat, { type: "info", text: `model → ${model}` });
      },
      async setEffort(effort) {
        await chat.thread.setEffort(effort);
        emit(chat, { type: "info", text: `effort → ${effort}` });
      },
      newSession() {
        if (chat.busy || headless(chat.bot.id)) return false;
        chat.thread.close("new session");
        newSession(cwd, chat.bot);
        chat.thread = openThread(chat.bot, false, () => chat);
        emit(chat, { type: "session" });
        return true;
      },
    };
  }

  return {
    execute: routineTurns.execute,
    deliver,
    notify: notices.notify,
    emitTo(botId, e) {
      const chat = chats.get(botId);
      if (chat) emit(chat, e);
    },
    isWorking,
    unattended: (botId) => !!chats.get(botId)?.routineTurn || headless(botId),
    botsEvent: () => botsEvent(cwd, db, isWorking),
    announceBots,
    currentBotId: () => current?.bot.id,
    open: () => current && openChat(current),
    switchTo,
    answer(id, value) {
      for (const c of chats.values()) {
        const resolve = c.pending.get(id);
        if (!resolve) continue;
        c.pending.delete(id);
        resolve(value);
        emit(c, { type: "answered", id, value });
        return true;
      }
      return false;
    },
    cancelQueued(id) {
      for (const c of chats.values()) {
        const i = c.inbox.findIndex((e) => e.source === "user" && e.id === id);
        if (i < 0) continue;
        c.inbox.splice(i, 1);
        emit(c, { type: "dequeued", id });
        return true;
      }
      return false;
    },
    reconfigure(botId, reason) {
      for (const chat of botId === undefined ? chats.values() : [chats.get(botId)]) {
        if (!chat) continue;
        if (chat.busy) chat.configStale = true;
        else chat.thread.close(reason);
      }
    },
    notices: notices.recent,
    replayOpen: () => (current ? [deps.routinesEvent(current.bot.id), { type: "reset", botId: current.bot.id }, ...current.history] : []),
    close() {
      for (const chat of chats.values()) chat.thread.close("shutdown");
      filesWatcher?.close();
    },
  };
}
