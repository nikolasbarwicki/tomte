import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, type FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";
import { z } from "zod";
import react from "@vitejs/plugin-react";
import { getSessionInfo, getSessionMessages, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { resolveCli } from "./cli.ts";
import { Thread, type TurnResult } from "./thread.ts";
import { botContext, botFilesPath, botMemoryPath, createBot, currentSession, getBot, listBots, newSession, touchBot } from "./bots.ts";
import { readMemory, userMemoryPath } from "./memory.ts";
import { watchHerdr } from "./herdr.ts";
import { deleteFile, listFiles, resolveInside, reveal, watchFiles } from "./files.ts";
import { openDb } from "./db.ts";
import { getActivity, markSeen, recordMessage } from "./activity-store.ts";
import { Conflict, NotFound, RoutineInput, createRoutines, headlessDelegate, runHeadless, type Executor, type RoutineJob } from "./routines.ts";
import { nextOccurrences } from "./schedule.ts";
import type { Bot, BotStatus, BotsEvent, FilesEvent, LastMessage, MemoryEvent, Notice, RoutinesEvent, RunTrigger, ServerEvent } from "../web/events.ts";

const [cwdArg, botArg] = process.argv.slice(2);
const PORT = Number(process.env.PORT ?? 5173);
const cli = resolveCli();
if (!cli && !process.env.ANTHROPIC_API_KEY) {
  console.error("refusing to start: no ANTHROPIC_API_KEY and no claude binary");
  process.exit(2);
}
if (!cli) {
  console.error("no claude binary resolved; set CLAUDE_PATH or run `bun src/host.ts install-cli`");
  process.exit(2);
}
const cwd = realpathSync(cwdArg ?? process.cwd());

const clients = new Set<ServerResponse>();
const broadcast = (e: ServerEvent | MemoryEvent | FilesEvent | RoutinesEvent | BotsEvent) => {
  for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`);
};

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

/** Closes a chat that is neither shown nor running; its session resumes from disk when the bot is opened again. */
function release(chat: Chat) {
  if (chat === current || chat.busy) return;
  chat.thread.close("released");
  chats.delete(chat.bot.id);
}
const memoryEvents = (): MemoryEvent[] => [
  { type: "memory", scope: "user", text: readMemory(userMemoryPath()) },
  { type: "memory", scope: "bot", text: current ? readMemory(botMemoryPath(cwd, current.bot.id)) : "" },
];

const filesEvent = (): FilesEvent => {
  const dir = current ? botFilesPath(cwd, current.bot.id) : "";
  return { type: "files", dir, files: dir ? listFiles(dir) : [] };
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
  const h = runHeadless(cwd, cli!, item.job);
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
  if (current) await narrate(current);
}

async function runRoutine(chat: Chat, item: QueuedRoutine) {
  item.stop = (reason) => chat.thread.close(reason);
  emit(chat, { type: "routine", name: item.job.routine.name, trigger: item.job.prompt.includes('trigger="manual"') ? "manual" : "schedule" });
  chat.routineTurn = true;
  const r = await turn(chat, item.job.prompt);
  r instanceof Error ? item.reject(r) : item.resolve(r.text);
}

const db = openDb(cwd);
const routines = createRoutines({
  db,
  cwd,
  execute,
  onChange: (botId) => {
    if (botId === current?.bot.id) broadcast(routinesEvent(current));
  },
});
const routinesEvent = (chat: Chat): RoutinesEvent => ({ type: "routines", botId: chat.bot.id, routines: routines.list(chat.bot.id) });

const botsEvent = (): BotsEvent => ({
  type: "bots",
  bots: listBots(cwd).map((bot) => {
    const activity = getActivity(db, bot.id);
    const last = activity?.last ?? null;
    const status: BotStatus =
      chats.get(bot.id)?.busy || headlessRuns.has(bot.id)
        ? "working"
        : last?.from === "bot" && last.at > (activity?.seenAt ?? 0)
          ? "unseen"
          : "idle";
    return { ...bot, last, status };
  }),
});
const announceBots = () => broadcast(botsEvent());

const stopHerdr = watchHerdr((title, body) => notify("herdr", title, body), (l) => console.error(l));

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
    cli: cli!,
    cwd,
    ...botContext(cwd, bot),
    resume,
    idleMs: 10 * 60_000,
    approveAll: process.env.CLAUDEBOT_ASK_APPROVAL !== "1",
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
async function replay(sessionId: string): Promise<ServerEvent[]> {
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
        else if (!text.startsWith("<")) out.push({ type: "user", text });
      }
    } else if (m.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text") out.push({ type: "text_start" }, { type: "delta", text: b.text });
        if (b.type === "tool_use") out.push({ type: "tool", name: b.name, input: JSON.stringify(b.input) });
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
      for (const e of await replay(id)) {
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
  const hasSession = !!(await getSessionInfo(currentSession(bot), { dir: cwd }));
  const history: ServerEvent[] = [];
  for (const [i, id] of bot.sessions.entries()) {
    if (i > 0) history.push({ type: "session" });
    if (i < bot.sessions.length - 1 || hasSession) history.push(...(await replay(id)));
  }
  return { history, hasSession };
}

function createChat(bot: Bot, { history, hasSession }: Transcript): Chat {
  const headless = headlessRuns.get(bot.id);
  if (headless) history.push({ type: "info", text: `routine "${headless}" is running in the background; its reply appears here when it finishes` });
  const chat: Chat = { bot, history, busy: false, routineTurn: false, pending: new Map(), thread: openThread(bot, hasSession, () => chat) };
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
    const chat = createChat(old.bot, t);
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
    for (const e of [botsEvent(), ...memoryEvents(), filesEvent(), ...notices, ...open]) res.write(`data: ${JSON.stringify(e)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  const b = await body(req);
  if (path.startsWith("/api/routines/")) return routineApi(res, path, b);
  const str = (key: string) => (typeof b[key] === "string" ? (b[key] as string) : "");
  switch (path) {
    case "/api/info":
      return json(res, { cwd, cli: `${cli!.path} (${cli!.source})`, auth: process.env.ANTHROPIC_API_KEY ? "api key" : "CLI stored login" });
    case "/api/seen": {
      const bot = getBot(cwd, str("botId"));
      if (!bot) return json(res, { error: "no such bot" }, 404);
      markSeen(db, bot.id, Date.now());
      announceBots();
      return json(res, { ok: true });
    }
    case "/api/bots/new": {
      if (!str("name").trim()) return json(res, { error: "name required" }, 400);
      const bot = createBot(cwd, str("name"), str("purpose"));
      await switchTo(bot);
      return json(res, bot);
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
      if (chat.busy) return json(res, { error: "a turn is already running" }, 409);
      if (headlessRuns.has(chat.bot.id)) return json(res, { error: "a routine is running in this chat; wait for it to finish" }, 409);
      emit(chat, { type: "user", text: str("text") });
      recordMessage(db, chat.bot.id, { from: "user", text: str("text"), at: Date.now() });
      json(res, { ok: true });
      void turn(chat, str("text"));
      return;
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
        return json(res, { next: nextOccurrences(Preview.parse(b).schedule, Date.now(), 3) });
    }
    res.writeHead(404).end();
  } catch (e) {
    if (e instanceof z.ZodError) return json(res, { error: e.issues.map((i) => i.message).join("; ") }, 400);
    if (e instanceof Conflict) return json(res, { error: e.message }, 409);
    if (e instanceof NotFound) return json(res, { error: e.message }, 404);
    throw e;
  }
}

function json(res: ServerResponse, v: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
}

const initial = botArg ? getBot(cwd, botArg) : listBots(cwd)[0];
if (botArg && !initial) {
  console.error(`no bot ${botArg} in ${cwd}`);
  process.exit(2);
}
if (initial) await switchTo(initial);
void backfillActivity()
  .then(announceBots)
  .catch((e) => console.error(`[host] activity backfill failed: ${(e as Error).message}`));

const http = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path.startsWith("/api/"))
    return void api(req, res, path).catch((e) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    });
  vite.middlewares(req, res);
});

const vite = await createVite({
  root: fileURLToPath(new URL("../web", import.meta.url)),
  plugins: [react()],
  server: { middlewareMode: true, hmr: { server: http } },
  appType: "spa",
});

routines.start();
http.listen(PORT, "127.0.0.1", () => {
  console.log(`claudebot UI: http://127.0.0.1:${PORT}  cwd=${cwd}  bot=${current ? `${current.bot.name} (${current.bot.id})` : "none"}`);
});

const shutdown = () => {
  for (const chat of chats.values()) chat.thread.close("shutdown");
  stopHerdr();
  filesWatcher?.close();
  routines.stop();
  if (current) console.log(`reopen with: bun run ui ${cwd} ${current.bot.id}`);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
