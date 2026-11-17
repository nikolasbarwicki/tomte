import type { Bot, MemoryScope, ServerEvent } from "@claudebot/contract/events";

import { frontContext, type HostDelegate, type ThreadEnv } from "../bots/index.ts";
import { ProgressAttribution, createLoopServer } from "./agents.ts";
import { FrontSession, type FrontOptions } from "./front.ts";
import { createPathGuard } from "./guard.ts";
import { Observer } from "./observe.ts";
import type { LoopStore } from "./store.ts";
import { Tasks } from "./tasks.ts";
import { MAX_PARALLEL } from "./work-state.ts";

export { FrontSession } from "./front.ts";
export { createLoopStore, type LoopStore, type SessionLog } from "./store.ts";
export { findingsOf, taskEvent } from "./tasks.ts";
export { withoutWorkState } from "./work-state.ts";

/** Opens a bot's front session in the host's shared thread environment, whose `hostServers` is the lease the front may use. */
export function openFront(
  {
    cwd,
    dataRoot,
    cli,
    claude,
    hostServers,
    botEnv,
    approveAll,
    allows,
    integrations,
    meter,
  }: ThreadEnv,
  bot: Bot,
  opts: {
    resume: boolean;
    delegate: HostDelegate;
    idleMs?: number;
    log: (line: string) => void;
    onMemory?: (scope: MemoryScope, text: string) => void;
    /** Where the session's tasks and reports are stored. */
    store: LoopStore;
    /** Shows the page a task snapshot, a status line or a report. */
    emit: (e: ServerEvent) => void;
    /** A task started or ended, so the presence line may move. */
    changed: () => void;
    /** Gives the front a message the app wrote, such as the request to start a queued task. */
    dispatch: (message: string) => void;
    onMessage: FrontOptions["onMessage"];
    onEnd: FrontOptions["onEnd"];
  },
): FrontSession {
  const { sessionId, persona, workerPersona, files, memory } = frontContext(dataRoot, bot);
  if (sessionId === undefined) throw new Error(`bot ${bot.id} has no session`);
  const { store, emit, changed, dispatch, onMessage, ...rest } = opts;
  const log = store.session(bot.id, sessionId);
  const attribution = new ProgressAttribution();
  const tasks = new Tasks({ log, maxParallel: MAX_PARALLEL, dispatch, emit });
  // The observer reads the agents' model and effort from the front, which the observer is built before.
  let front: FrontSession;
  const observer = new Observer({
    log,
    tasks,
    attribution,
    emit,
    // A task that ends may free a slot or be what a queued task waits for.
    changed: () => {
      changed();
      tasks.pump();
    },
    defaults: () => front.agentSettings,
    // The worker's file tools stay in the workspace and the bot's files folder.
    guard: createPathGuard({ cwd, roots: [cwd, files] }),
    logLine: opts.log,
  });
  front = new FrontSession({
    cli,
    claude,
    cwd,
    sessionId,
    hostServers: () => hostServers(bot.id),
    meter,
    botId: bot.id,
    env: () => botEnv(bot.id),
    approveAll,
    allows: (tool) => allows(bot.id, tool),
    persona,
    workerPersona,
    files,
    memory,
    observer,
    tasks,
    loopServer: createLoopServer({
      attribution,
      onProgress: (taskId, progress) => observer.recordProgress(taskId, progress),
      queue: (goal, agentType, after) => tasks.queue(goal, agentType, after),
      cancelQueued: (id) => tasks.cancelQueued(id),
    }),
    onStopped: () => observer.interruptRunning(),
    agentSettings: { model: bot.model, effort: bot.effort },
    // Nothing closes the front for an expiring token while agents run; the session is read at open, as a standard thread's is.
    integrations,
    onMessage: (m) => {
      observer.onMessage(m);
      onMessage(m);
    },
    ...rest,
  });
  return front;
}
