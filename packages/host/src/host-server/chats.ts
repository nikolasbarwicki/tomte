import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { FSWatcher } from "node:fs";

import type { EffortLevel, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Bot,
  BotsEvent,
  HostEvent,
  Presence,
  RoutinesEvent,
  ServerEvent,
  WorkEvent,
} from "@claudebot/contract/events";

import {
  botFilesPath,
  getBot,
  listBots,
  newSession,
  recordMessage,
  touchBot,
  watchFiles,
  type Thread,
  type ThreadEnv,
  type TurnResult,
} from "../bots/index.ts";
import type { Events, ExternalRow } from "../events/index.ts";
import type { Handoffs, Mention } from "../handoffs/index.ts";
import type { HostServersSource } from "../harness/index.ts";
import { openFront, type FrontSession, type LoopStore } from "../loop/index.ts";
import type { Executor } from "../routines/index.ts";
import { createRoutineTurns } from "./routine-turns.ts";
import { hostDelegate, openBotThread, type ThreadHooks } from "./threads.ts";
import type { Transcript } from "./transcript.ts";
import { botsEvent, filesEvent, memoryEvents } from "./views.ts";

export interface ChatsDeps extends ThreadEnv {
  /** The host servers a double-loop bot's front session may use; `hostServers` is what a standard bot's thread gets. */
  frontServers: HostServersSource;
  db: Database;
  /** How long an idle double-loop front stays open; 10 minutes when omitted. */
  frontIdleMs?: number;
  /** Where a double-loop bot's tasks and reports are kept. */
  loop: LoopStore;
  handoffs: Pick<Handoffs, "receivedCards" | "startDelivered">;
  events: Pick<Events, "split" | "needsYou">;
  /** External needs-you items, so chats can tie an answer to the one it answers. `acted` closes an item the user answered, with the answer to relay to the sender. */
  items: {
    isOpen(botId: string, id: string): boolean;
    acted(botId: string, id: string, answer: string): void;
  };
  transcript: (bot: Bot) => Promise<Transcript>;
  /** Human-wait cards still open for a bot, replayed into a rebuilt chat. */
  pendingWaits: (botId: string) => ServerEvent[];
  routinesEvent(botId: string): RoutinesEvent;
  workEvent(botId: string): WorkEvent;
  broadcast: (e: HostEvent) => void;
}

/** The chat the page shows, with what the user can do in it. */
export interface OpenChat {
  bot: Bot;
  /**
   * Gives the user's message to the bot, or resolves a question it asked, and returns what happened. With `eventId` the message answers that needs-you item, and the host decides where the answer goes:
   * - `answered`: the bot has a pending question linked to this item; it receives `answer` (the message when omitted) as the question's answer, and the item is closed as acted. No chat message is created, and queued answers to the item are cancelled.
   * - `queued`: the bot is busy; the item is closed only when the entry is delivered, never on queueing.
   * - `start`: shows the message and runs the turn; the item is closed as it starts. A double-loop bot always answers `start` (its front takes the message even mid-turn) and never `queued`.
   * - `refused`: the item is not open for this bot any more, or an answer to it is already queued.
   */
  send(
    text: string,
    shown: string,
    mentions: Mention[],
    eventId?: string,
    answer?: string,
  ): { answered: string } | { queued: string } | { start(): void } | { refused: string };
  setModel(model: string): Promise<void>;
  setEffort(effort: EffortLevel): Promise<void>;
  /** Starts a new session; false while a turn is running or a double-loop front is answering. */
  newSession(): boolean;
}

export interface Chats {
  /** Runs a routine turn in its bot's chat once the bot is free, or headless when the bot has no chat. */
  execute: Executor;
  /** Sends a host message into a bot's session: queued while the bot is busy, and the session reopens if it is closed. A double-loop bot's front takes it at once, as a synthetic message. */
  deliver(botId: string, text: string): Promise<void>;
  /** Shows an event in a bot's chat if it has one. */
  emitTo(botId: string, e: ServerEvent): void;
  /** Gives the external-event rows already in a bot's chat their new state, shown live when the chat is. */
  updateExternal(botId: string, rows: ExternalRow[]): void;
  isWorking(botId: string): boolean;
  /** True while no human is watching the bot's turn: a routine turn or a headless run. */
  unattended(botId: string): boolean;
  botsEvent(): BotsEvent;
  currentBotId: () => string | undefined;
  announceBots: () => void;
  open(): OpenChat | undefined;
  /** Shows the bot's chat; a chat still running in the background is shown as it is, live. */
  switchTo(bot: Bot): Promise<void>;
  /** Closes and forgets a deleted bot's chat; when it was the shown one, shows the most recently active bot, or nothing. */
  drop(botId: string): Promise<void>;
  /** Answers a question or approval, and acknowledges the external event the question was linked to; false when there is no such question. */
  answer(id: string, value: string): boolean;
  /** The id of the bot's oldest pending question that was asked about this external event, if any. */
  pendingAskFor(botId: string, eventId: string): string | undefined;
  /** Takes back a queued user message; false when it already reached the bot. */
  cancelQueued(id: string): boolean;
  /** Starts a new session for a bot, with or without a chat; false while it is running a turn. */
  newSession(botId: string): boolean;
  /** Reopens a bot's thread, or every bot's, to pick up changed settings; a busy chat reopens after its turn. */
  reconfigure(botId: string | undefined, reason: string): void;
  /** The open chat's routines, reset marker and transcript, replayed on connect. */
  replayOpen(): HostEvent[];
  close(): void;
}

/** A message waiting for its bot to be free. `text` is what the bot receives. A user entry also keeps what the page shows, so it can be listed and cancelled until it runs, and the needs-you item it answers, closed when it is delivered, with `said` as the answer to relay. */
type UserEntry = {
  source: "user";
  id: string;
  text: string;
  shown: string;
  mentions: Mention[];
  eventId?: string;
  said?: string;
};
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
  /** Questions and approvals waiting for the user, by id. A question asked about an external event keeps its id. */
  pending: Map<string, { resolve: (value: string) => void; eventId?: string }>;
  /** External events that reached the bot's current session; the only ones a question may claim to be about. */
  delivered: Set<string>;
  /** Integration or bot settings changed during a standard turn; the thread reopens once the turn ends. A front has its own deferred close. */
  configStale: boolean;
  /** Messages for the bot that start the next turn once it is free: the user's sends while it was busy, and host messages (a human wait's outcome). */
  inbox: InboxEntry[];
  /** The front session of a double-loop bot; absent for a standard bot, whose turns run on `thread`. A double-loop chat never uses `busy` or `inbox`. */
  front: FrontSession | undefined;
  /** What a double-loop chat shows as its presence line; always `idle` for a standard bot. */
  presence: Presence;
  /** What the front has said in the turn running now, for when its result carries no text of its own. */
  frontText: string;
  /** Routine turns waiting for the front's next result. */
  frontWaiters: ((r: TurnResult | Error) => void)[];
  /** Host messages for the front that wait out a headless routine run writing the same session. */
  held: string[];
};

export function createChats(deps: ChatsDeps): Chats {
  const { dataRoot, db, broadcast } = deps;
  const chats = new Map<string, Chat>();
  /** The chat shown in the UI. */
  let current: Chat | undefined;
  /** Counts switches so an earlier switch still loading its transcript does not override a later one. */
  let switches = 0;
  /** Pushes the open bot's file list to the page whenever its folder changes. */
  let filesWatcher: FSWatcher | undefined;
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
  const isWorking = (botId: string) => {
    const chat = chats.get(botId);
    return !!chat?.busy || (chat !== undefined && chat.presence !== "idle") || headless(botId);
  };
  const chatsBotsEvent = () => botsEvent(dataRoot, db, isWorking, deps.events.needsYou);
  const announceBots = () => broadcast(chatsBotsEvent());

  const queuedEvent = (e: UserEntry): ServerEvent =>
    e.mentions.length
      ? { type: "queued", id: e.id, text: e.shown, mentions: e.mentions }
      : { type: "queued", id: e.id, text: e.shown };

  /** Shows a user message in the transcript and records it as the bot's latest; called when it reaches the bot. */
  function userSaid(chat: Chat, text: string, mentions: Mention[]) {
    emit(chat, mentions.length ? { type: "user", text, mentions } : { type: "user", text });
    recordMessage(db, chat.bot.id, { from: "user", text, at: Date.now() });
  }

  /** Closes a chat that is neither shown nor running; its session resumes from disk when the bot is opened again. */
  function release(chat: Chat) {
    if (chat === current || chat.busy || chat.inbox.length || chat.presence !== "idle") return;
    if (chat.front && !chat.front.idle()) return;
    chat.front?.tasks.dispose();
    closeSessions(chat, "released");
    chats.delete(chat.bot.id);
  }

  /** Closes whatever CLI sessions a chat holds: its thread, and the front of a double-loop bot. */
  function closeSessions(chat: Chat, reason: string) {
    chat.thread.close(reason);
    chat.front?.close(reason);
    chat.presence = "idle";
    chat.frontText = "";
    settleWaiters(chat, new Error(reason));
  }

  function settleWaiters(chat: Chat, result: TurnResult | Error) {
    for (const waiter of chat.frontWaiters.splice(0)) waiter(result);
  }

  /** The latest rate limit report of each window. The limits belong to the account, not to a chat, so they outlive a new session and a reload; only a double-loop bot's page is sent them. */
  const rateLimits = new Map<string, ServerEvent>();

  /** Changes what a double-loop chat's presence line shows, and the bot's sidebar status with it. */
  function setPresence(chat: Chat, state: Presence) {
    if (chat.presence === state) return;
    chat.presence = state;
    if (chat === current) broadcast({ type: "presence", state });
    announceBots();
  }

  /** Whether a message of the front's session is the front's own, not an agent's. */
  const fromFront = (m: SDKMessage) =>
    (m.type !== "assistant" && m.type !== "stream_event") ||
    (!m.parent_tool_use_id && !("agent_id" in m && m.agent_id));

  /** What a double-loop chat's presence says while its front is not streaming: working while agents run. */
  const restingPresence = (chat: Chat): Presence =>
    (chat.front?.observer.running() ?? 0) > 0 ? "working" : "idle";

  /** An agent started or ended: the presence line follows, unless the front is streaming, whose result settles it. The front's turn on the task's notification follows, and its end releases an unshown chat. */
  function tasksChanged(chat: Chat) {
    if (chat.presence !== "typing") setPresence(chat, restingPresence(chat));
  }

  /** Shows what the loop observed: a task's snapshot and a report join the transcript, a status line is only shown live. */
  function emitLoop(chat: Chat, e: ServerEvent) {
    if (e.type === "rate_limit") {
      rateLimits.set(e.window ?? "", e);
      if (chat === current) broadcast(e);
      return;
    }
    if (e.type === "task_status") {
      if (chat === current) broadcast(e);
      return;
    }
    emit(chat, e);
    if (e.type !== "report") return;
    recordMessage(db, chat.bot.id, { from: "bot", text: e.text, at: Date.now() });
    announceBots();
  }

  /** Starts every routine turn whose bot is free, then delivers queued inbox entries. */
  async function drain() {
    routineTurns.startReady(
      (botId) => chats.get(botId),
      (chat, job) => {
        emit(chat, {
          type: "routine",
          name: job.routine.name,
          trigger: job.prompt.includes('trigger="manual"') ? "manual" : "schedule",
        });
        if (chat.front) {
          // A double-loop chat has no turn of its own: the routine's prompt goes to the front, and the routine ends with the front's next result.
          const { promise, resolve } = Promise.withResolvers<TurnResult | Error>();
          chat.frontWaiters.push(resolve);
          pushToFront(chat, job.prompt, true);
          return { done: promise, stop: (reason) => closeSessions(chat, reason) };
        }
        chat.routineTurn = true;
        return { done: turn(chat, job.prompt), stop: (reason) => chat.thread.close(reason) };
      },
    );
    for (const chat of chats.values()) {
      if (chat.front && chat.held.length && !headless(chat.bot.id))
        for (const text of chat.held.splice(0)) pushToFront(chat, text, true);
      if (!chat.inbox.length || chat.busy || headless(chat.bot.id)) continue;
      const entries = chat.inbox.splice(0);
      for (const e of entries) {
        if (e.source === "user") {
          emit(chat, { type: "dequeued", id: e.id });
          userSaid(chat, e.shown, e.mentions);
          if (e.eventId) deps.items.acted(chat.bot.id, e.eventId, e.said ?? e.shown);
        } else showDelivered(chat, e.text);
      }
      void turn(chat, entries.map((e) => e.text).join("\n\n"));
    }
  }

  /** Shows a host message's external events and received handoffs as the rows and cards they are, and notes which events the session was given. */
  function showDelivered(chat: Chat, text: string) {
    for (const piece of deps.events.split(chat.bot.id, text))
      if (typeof piece !== "string") {
        chat.delivered.add(piece.id);
        emit(chat, piece);
      }
    for (const card of deps.handoffs.receivedCards(text, chat.bot.id)) emit(chat, card);
  }

  async function deliver(botId: string, text: string) {
    const bot = getBot(dataRoot, botId);
    if (!bot) return;
    let chat = chats.get(botId);
    if (!chat) {
      const t = await deps.transcript(bot);
      chat = chats.get(botId) ?? createChat(bot, t);
    }
    if (chat.front) {
      showDelivered(chat, text);
      messageFront(chat, text);
      return;
    }
    chat.inbox.push({ source: "host", text });
    await drain();
  }

  /** Gives a double-loop bot's front a message the app wrote; it waits while a scheduled run is writing the conversation. */
  function messageFront(chat: Chat, text: string) {
    if (headless(chat.bot.id)) chat.held.push(text);
    else pushToFront(chat, text, true);
  }

  /** Gives a double-loop bot's front a message, which it takes mid-turn if it is busy; the reply streams through `onFrontMessage`. */
  function pushToFront(chat: Chat, text: string, synthetic: boolean) {
    const front = chat.front;
    if (!front) return;
    deps.handoffs.startDelivered(text);
    touchBot(dataRoot, chat.bot);
    setPresence(chat, "typing");
    front.send(text, synthetic).catch((e: Error) => frontFailed(chat, e));
  }

  function frontFailed(chat: Chat, e: Error) {
    emit(chat, { type: "error", message: e.message });
    chat.frontText = "";
    settleWaiters(chat, e);
    setPresence(chat, restingPresence(chat));
    release(chat);
    void drain();
  }

  /** The front ends a turn on its own schedule, not once per message, so a result closes whatever turn is running. */
  function onFrontMessage(chat: Chat, m: SDKMessage) {
    // What an agent says and does is shown through its task, never as the front's own words or tool calls.
    const own = fromFront(m);
    if (own) showMessage(chat, m);
    if (m.type === "assistant" && own)
      for (const blk of m.message.content) if (blk.type === "text") chat.frontText += blk.text;
    if ((m.type === "stream_event" || m.type === "assistant") && own) setPresence(chat, "typing");
    if (m.type !== "result") return;
    const said = m.subtype === "success" ? m.result || chat.frontText : "";
    chat.frontText = "";
    if (m.subtype === "success" && !m.is_error) {
      emit(chat, { type: "done" });
      if (said.trim()) recordMessage(db, chat.bot.id, { from: "bot", text: said, at: Date.now() });
      settleWaiters(chat, { result: m, text: said, toolsUsed: [] });
    } else {
      const detail = "errors" in m ? m.errors.join("; ") : m.result;
      const failure = new Error(`turn failed (${m.subtype}): ${detail}`);
      emit(chat, { type: "error", message: failure.message });
      settleWaiters(chat, failure);
    }
    setPresence(chat, restingPresence(chat));
    void afterFrontTurn(chat);
  }

  async function afterFrontTurn(chat: Chat) {
    const usage = await chat.front
      ?.contextUsage()
      .catch((e) => console.error(`[host] context usage failed: ${(e as Error).message}`));
    if (usage) emit(chat, { type: "context", ...usage });
    // A close that waited for the agents (changed settings, an expiring token) applies once the front is idle.
    chat.front?.settle();
    release(chat);
    void drain();
  }

  /** Shows what an SDK message means to the page: a compaction, a tool call, a streamed piece of text. */
  function showMessage(chat: Chat, m: SDKMessage) {
    if (m.type === "system" && m.subtype === "compact_boundary")
      emit(chat, {
        type: "compacted",
        trigger: m.compact_metadata.trigger,
        preTokens: m.compact_metadata.pre_tokens,
      });
    if (m.type === "assistant")
      for (const blk of m.message.content)
        if (blk.type === "tool_use")
          emit(chat, { type: "tool", name: blk.name, input: JSON.stringify(blk.input) });
    if (m.type !== "stream_event" || m.parent_tool_use_id) return;
    const ev = m.event;
    if (ev.type === "content_block_start" && ev.content_block.type === "text")
      emit(chat, { type: "text_start" });
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta")
      emit(chat, { type: "delta", text: ev.delta.text });
  }

  /** Runs one turn in a chat, shown or not; failures are shown there and returned. */
  async function turn(chat: Chat, text: string): Promise<TurnResult | Error> {
    chat.busy = true;
    deps.handoffs.startDelivered(text);
    touchBot(dataRoot, chat.bot);
    announceBots();
    let out: TurnResult | Error;
    try {
      out = await chat.thread.send(text, (m) => showMessage(chat, m));
      emit(chat, { type: "done" });
      if (out.text.trim())
        recordMessage(db, chat.bot.id, { from: "bot", text: out.text, at: Date.now() });
      const usage = await chat.thread
        .contextUsage()
        .catch((e) => console.error(`[host] context usage failed: ${(e as Error).message}`));
      if (usage) emit(chat, { type: "context", ...usage });
    } catch (e) {
      out = e as Error;
      emit(chat, { type: "error", message: out.message });
    } finally {
      chat.busy = false;
      chat.routineTurn = false;
      dropLinkedAsks(chat);
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

  /** A turn's end leaves no tool call waiting, so a question linked to an event can no longer reach the bot: answering it later must not acknowledge the event. */
  function dropLinkedAsks(chat: Chat) {
    for (const [id, p] of chat.pending)
      if (p.eventId !== undefined) {
        console.error(`[chat] question ${id} about event ${p.eventId} outlived its turn; dropped`);
        chat.pending.delete(id);
        emit(chat, { type: "ask_expired", id });
      }
  }

  /** Resolves a pending question, then closes the external event it was linked to, relaying `said` (the answer when omitted) to its sender, and cancels queued answers to that event, which the question's answer replaces. */
  function answerAsk(id: string, value: string, said = value): boolean {
    for (const c of chats.values()) {
      const asked = c.pending.get(id);
      if (!asked) continue;
      c.pending.delete(id);
      asked.resolve(value);
      emit(c, { type: "answered", id, value });
      if (asked.eventId !== undefined) {
        const answers = c.inbox.filter(
          (e): e is UserEntry => e.source === "user" && e.eventId === asked.eventId,
        );
        for (const e of answers) cancelEntry(c, e);
        deps.items.acted(c.bot.id, asked.eventId, said);
      }
      return true;
    }
    return false;
  }

  function cancelEntry(chat: Chat, entry: UserEntry) {
    chat.inbox.splice(chat.inbox.indexOf(entry), 1);
    emit(chat, { type: "dequeued", id: entry.id });
  }

  /** The id of the bot's oldest pending question that was asked about this external event, if any. */
  function pendingAskFor(botId: string, eventId: string): string | undefined {
    return [...(chats.get(botId)?.pending ?? [])].find(([, p]) => p.eventId === eventId)?.[0];
  }

  /** The external events in the bot's current session: the rows after the last session marker of a transcript. */
  function deliveredIn(history: ServerEvent[]): Set<string> {
    const ids = new Set<string>();
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i];
      if (e?.type === "session") break;
      if (e?.type === "external") ids.add(e.id);
    }
    return ids;
  }

  const waitForUser = (chat: Chat, event: (id: string) => ServerEvent, eventId?: string) => {
    const id = randomUUID();
    const { promise, resolve } = Promise.withResolvers<string>();
    chat.pending.set(id, eventId === undefined ? { resolve } : { resolve, eventId });
    emit(chat, event(id));
    return promise;
  };

  /** `chat` is read lazily: the sessions are created while their chat is being built. */
  const sessionHooks = (bot: Bot, chat: () => Chat): ThreadHooks => ({
    onMemory: (scope, text) => {
      if (scope === "user" || current?.bot.id === bot.id)
        broadcast({ type: "memory", scope, text });
    },
    unattended: () => chat().routineTurn,
    ownedEvent(claimed) {
      if (claimed === undefined) return undefined;
      const { bot: owner, delivered } = chat();
      if (delivered.has(claimed) && deps.items.isOpen(owner.id, claimed)) return claimed;
      console.error(
        `[chat] ask_user named event ${JSON.stringify(claimed.slice(0, 80))}, which bot ${owner.id} was not given or is closed; unlinked`,
      );
      return undefined;
    },
    ask: (event, eventId) => waitForUser(chat(), event, eventId),
  });

  const openThread = (bot: Bot, resume: boolean, chat: () => Chat): Thread =>
    openBotThread(deps, bot, resume, sessionHooks(bot, chat));

  /** The front session of a double-loop bot; a standard bot has none. */
  const openFrontSession = (
    bot: Bot,
    resume: boolean,
    chat: () => Chat,
  ): FrontSession | undefined => {
    if (bot.chatMode !== "double_loop") return undefined;
    const hooks = sessionHooks(bot, chat);
    return openFront({ ...deps, hostServers: deps.frontServers }, bot, {
      resume,
      idleMs: deps.frontIdleMs ?? 10 * 60_000,
      log: (l) => console.error(l),
      onMemory: hooks.onMemory,
      delegate: hostDelegate(hooks),
      store: deps.loop,
      emit: (e) => emitLoop(chat(), e),
      changed: () => tasksChanged(chat()),
      dispatch: (text) => messageFront(chat(), text),
      onMessage: (m) => onFrontMessage(chat(), m),
      onEnd: (e) => frontFailed(chat(), e),
    });
  };

  function createChat(
    bot: Bot,
    { history, hasSession }: Transcript,
    inbox: InboxEntry[] = [],
  ): Chat {
    history.push(...deps.pendingWaits(bot.id));
    const routine = routineTurns.headless(bot.id);
    if (routine)
      history.push({
        type: "info",
        text: `routine "${routine}" is running in the background; its reply appears here when it finishes`,
      });
    for (const e of inbox) if (e.source === "user") history.push(queuedEvent(e));
    const chat: Chat = {
      bot,
      history,
      busy: false,
      routineTurn: false,
      pending: new Map(),
      delivered: deliveredIn(history),
      configStale: false,
      inbox,
      front: openFrontSession(bot, hasSession, () => chat),
      presence: "idle",
      frontText: "",
      frontWaiters: [],
      held: [],
      thread: openThread(bot, hasSession, () => chat),
    };
    chats.set(bot.id, chat);
    return chat;
  }

  /** Sends the page everything about the chat it now shows. */
  function show(chat: Chat) {
    broadcast({ type: "reset", botId: chat.bot.id });
    for (const e of chat.history) broadcast(e);
    if (chat.front) {
      for (const e of chat.front.observer.statusEvents()) broadcast(e);
      broadcast({ type: "presence", state: chat.presence });
      for (const e of rateLimits.values()) broadcast(e);
    }
    announceBots();
    for (const e of memoryEvents(dataRoot, chat.bot.id)) broadcast(e);
    filesWatcher?.close();
    filesWatcher = watchFiles(botFilesPath(dataRoot, chat.bot.id), () =>
      broadcast(filesEvent(dataRoot, current?.bot.id)),
    );
    broadcast(filesEvent(dataRoot, chat.bot.id));
    broadcast(deps.routinesEvent(chat.bot.id));
    broadcast(deps.workEvent(chat.bot.id));
    recoverFront(chat);
  }

  /** A chat opening after an app restart (or a front that died) tells its front about the agents that were cut off, so it resumes them. A scheduled run writing the conversation delays it until the chat is shown again. */
  function recoverFront(chat: Chat) {
    const front = chat.front;
    if (!front?.needsRecovery() || headless(chat.bot.id)) return;
    setPresence(chat, "typing");
    front.recover().then(
      (told) => {
        if (!told) setPresence(chat, restingPresence(chat));
      },
      (e: Error) => frontFailed(chat, e),
    );
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

  async function drop(botId: string) {
    const chat = chats.get(botId);
    if (chat) {
      chat.front?.tasks.dispose();
      closeSessions(chat, "bot deleted");
      chats.delete(botId);
    }
    if (current?.bot.id !== botId) return announceBots();
    current = undefined;
    const next = listBots(dataRoot)[0];
    if (next) return switchTo(next);
    filesWatcher?.close();
    filesWatcher = undefined;
    announceBots();
    for (const e of memoryEvents(dataRoot, undefined)) broadcast(e);
    broadcast(filesEvent(dataRoot, undefined));
  }

  /** Rebuilds an idle chat from disk once a headless routine has written its session. */
  async function reload(old: Chat) {
    const t = await deps.transcript(old.bot);
    if (chats.get(old.bot.id) === old && !old.busy) {
      closeSessions(old, "reload");
      const chat = createChat(old.bot, t, old.inbox);
      if (current === old) {
        current = chat;
        show(chat);
      }
    }
    void drain();
  }

  function startSession(chat: Chat): boolean {
    if (chat.busy || chat.presence !== "idle" || headless(chat.bot.id)) return false;
    // The queue belongs to the conversation that ends here.
    chat.front?.tasks.cancelAllQueued();
    chat.front?.tasks.dispose();
    closeSessions(chat, "new session");
    newSession(dataRoot, chat.bot);
    chat.delivered.clear();
    chat.held = [];
    chat.thread = openThread(chat.bot, false, () => chat);
    // Saving the bot refreshed its mode, so the new session is the mode the bot is in now.
    chat.front = openFrontSession(chat.bot, false, () => chat);
    emit(chat, { type: "session" });
    return true;
  }

  function openChat(chat: Chat): OpenChat {
    return {
      bot: chat.bot,
      send(text, shown, mentions, eventId, answer) {
        if (eventId !== undefined) {
          if (!deps.items.isOpen(chat.bot.id, eventId))
            return { refused: "that item is already handled" };
          const ask = pendingAskFor(chat.bot.id, eventId);
          if (ask !== undefined && answerAsk(ask, answer ?? text, answer ?? shown))
            return { answered: ask };
          if (chat.inbox.some((e) => e.source === "user" && e.eventId === eventId))
            return { refused: "an answer to that item is already queued" };
        }
        if (chat.front) {
          if (headless(chat.bot.id))
            return {
              refused: "a scheduled run is writing this conversation; try again when it ends",
            };
          userSaid(chat, shown, mentions);
          return {
            start() {
              pushToFront(chat, text, false);
              if (eventId !== undefined) deps.items.acted(chat.bot.id, eventId, answer ?? shown);
            },
          };
        }
        if (chat.busy || headless(chat.bot.id)) {
          const entry: UserEntry = {
            source: "user",
            id: randomUUID(),
            text,
            shown,
            mentions,
            ...(eventId !== undefined && { eventId, said: answer ?? shown }),
          };
          chat.inbox.push(entry);
          emit(chat, queuedEvent(entry));
          return { queued: entry.id };
        }
        userSaid(chat, shown, mentions);
        return {
          start() {
            void turn(chat, text);
            if (eventId !== undefined) deps.items.acted(chat.bot.id, eventId, answer ?? shown);
          },
        };
      },
      async setModel(model) {
        await chat.thread.setModel(model);
        // The background agents run on the bot's model; their definitions are read when the front next opens.
        chat.front?.setAgentSettings({ model });
        emit(chat, { type: "info", text: `model → ${model}` });
      },
      async setEffort(effort) {
        await chat.thread.setEffort(effort);
        chat.front?.setAgentSettings({ effort });
        emit(chat, { type: "info", text: `effort → ${effort}` });
      },
      newSession: () => startSession(chat),
    };
  }

  return {
    execute: routineTurns.execute,
    deliver,
    emitTo(botId, e) {
      const chat = chats.get(botId);
      if (chat) emit(chat, e);
    },
    updateExternal(botId, rows) {
      const chat = chats.get(botId);
      if (!chat) return;
      for (const row of rows) {
        const at = chat.history.findIndex((e) => e.type === "external" && e.id === row.id);
        if (at < 0) continue;
        chat.history[at] = row;
        if (chat === current)
          broadcast({
            type: "external_state",
            id: row.id,
            state: row.state,
            ...(row.relay && { relay: row.relay }),
          });
      }
    },
    isWorking,
    unattended: (botId) => !!chats.get(botId)?.routineTurn || headless(botId),
    botsEvent: chatsBotsEvent,
    announceBots,
    currentBotId: () => current?.bot.id,
    open: () => current && openChat(current),
    switchTo,
    drop,
    answer: answerAsk,
    pendingAskFor,
    cancelQueued(id) {
      for (const c of chats.values()) {
        const entry = c.inbox.find((e): e is UserEntry => e.source === "user" && e.id === id);
        if (!entry) continue;
        cancelEntry(c, entry);
        return true;
      }
      return false;
    },
    newSession(botId) {
      const chat = chats.get(botId);
      if (chat) return startSession(chat);
      const bot = getBot(dataRoot, botId);
      if (!bot || headless(botId)) return false;
      newSession(dataRoot, bot);
      return true;
    },
    reconfigure(botId, reason) {
      for (const chat of botId === undefined ? chats.values() : [chats.get(botId)]) {
        if (!chat) continue;
        // Closing a front kills its agents, so it closes once it is idle.
        if (chat.front) chat.front.closeWhenIdle(reason);
        else if (chat.busy) chat.configStale = true;
        else closeSessions(chat, reason);
      }
    },
    replayOpen: () =>
      current
        ? [
            deps.routinesEvent(current.bot.id),
            deps.workEvent(current.bot.id),
            { type: "reset", botId: current.bot.id },
            ...current.history,
            ...(current.front
              ? [
                  ...current.front.observer.statusEvents(),
                  { type: "presence" as const, state: current.presence },
                  ...rateLimits.values(),
                ]
              : []),
          ]
        : [],
    close() {
      for (const chat of chats.values()) {
        chat.front?.tasks.dispose();
        closeSessions(chat, "shutdown");
      }
      filesWatcher?.close();
    },
  };
}
