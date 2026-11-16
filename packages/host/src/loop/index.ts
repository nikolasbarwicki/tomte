import type { Bot, MemoryScope, ServerEvent } from "@claudebot/contract/events";

import { frontContext, type HostDelegate, type ThreadEnv } from "../bots/index.ts";
import { ProgressAttribution, createLoopServer } from "./agents.ts";
import { FrontSession, type FrontOptions } from "./front.ts";
import { Observer } from "./observe.ts";
import type { LoopStore } from "./store.ts";

export { FrontSession } from "./front.ts";
export { taskEvent } from "./observe.ts";
export { createLoopStore, type LoopStore, type SessionLog } from "./store.ts";
export { withoutWorkState } from "./work-state.ts";

/** Opens a bot's front session in the host's shared thread environment, whose `hostServers` is the lease the front may use. */
export function openFront(
  { cwd, dataRoot, cli, claude, hostServers, botEnv, approveAll }: ThreadEnv,
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
    onMessage: FrontOptions["onMessage"];
    onEnd: FrontOptions["onEnd"];
  },
): FrontSession {
  const { sessionId, persona, memory } = frontContext(dataRoot, bot);
  if (sessionId === undefined) throw new Error(`bot ${bot.id} has no session`);
  const { store, emit, changed, onMessage, ...rest } = opts;
  const attribution = new ProgressAttribution();
  // The observer reads the agents' model and effort from the front, which the observer is built before.
  let front: FrontSession;
  const observer = new Observer({
    log: store.session(bot.id, sessionId),
    attribution,
    emit,
    changed,
    defaults: () => front.agentSettings,
    logLine: opts.log,
  });
  front = new FrontSession({
    cli,
    claude,
    cwd,
    sessionId,
    hostServers: () => hostServers(bot.id),
    env: () => botEnv(bot.id),
    approveAll,
    persona,
    memory,
    observer,
    loopServer: createLoopServer({
      attribution,
      onProgress: (taskId, progress) => observer.recordProgress(taskId, progress),
    }),
    onStopped: () => observer.interruptRunning(),
    onMessage: (m) => {
      observer.onMessage(m);
      onMessage(m);
    },
    ...rest,
  });
  return front;
}
