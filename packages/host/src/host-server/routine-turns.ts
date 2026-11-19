import type { Database } from "bun:sqlite";

import { recordMessage, type ThreadEnv, type TurnResult } from "../bots/index.ts";
import {
  parkingDelegate,
  runHeadless,
  type Executor,
  type RoutineJob,
  type RoutineTurnResult,
} from "../routines/index.ts";
import type { Waits } from "../waits/index.ts";

/** A routine turn waiting for its bot; it runs in the bot's chat once that is idle, or headless if the bot has no chat or the run has a session of its own. */
type QueuedRoutine = {
  job: RoutineJob;
  resolve(result: RoutineTurnResult): void;
  reject: (e: Error) => void;
  stop?: (reason: string) => void;
};

/** A routine turn started in a bot's chat. */
type ChatRoutineTurn = { done: Promise<TurnResult | Error>; stop: (reason: string) => void };

export interface RoutineTurnsDeps extends ThreadEnv {
  /** Where a headless run's questions and approvals park. */
  waits: Pick<Waits, "open" | "consumeApproval">;
  db: Database;
  announceBots: () => void;
  /** A headless run in the bot's current session ended; the bot's chat, if any, may now show it. */
  headlessDone(botId: string): void;
  /** Something queued; start whatever can run. */
  wake(): void;
}

export interface RoutineTurns {
  execute: Executor;
  /** The routine a headless run is writing the bot's current session for; that bot's chat must not start its own turn meanwhile. A run in a session of its own never blocks the chat. */
  headless(botId: string): string | undefined;
  /** The bot's headless run, in the bot's session or in one of its own (`sessionId` is then its own). */
  headlessRun(botId: string): { runId: string; sessionId: string | undefined } | undefined;
  /** Starts every queued routine whose bot is free: in the bot's chat when it has one, headless otherwise or when the run has a session of its own. */
  startReady<C extends { busy: boolean }>(
    chatOf: (botId: string) => C | undefined,
    runInChat: (chat: C, job: RoutineJob) => ChatRoutineTurn,
  ): void;
}

export function createRoutineTurns(deps: RoutineTurnsDeps): RoutineTurns {
  const { db } = deps;
  let routineQueue: QueuedRoutine[] = [];
  const headlessRuns = new Map<
    string,
    { routine: string; runId: string; ownSession: string | undefined }
  >();

  function startHeadless(item: QueuedRoutine) {
    const { bot, routine, runId, ownSession } = item.job;
    const h = runHeadless(
      deps,
      item.job,
      parkingDelegate(deps.waits, bot.id, (tool) => deps.integrations.locked(tool)),
    );
    item.stop = h.stop;
    headlessRuns.set(bot.id, { routine: routine.name, runId, ownSession });
    deps.announceBots();
    h.done
      .then((result) => {
        // A run in a session of its own reports through its run output; the bot's chat has no message from it.
        if (result.text.trim() && ownSession === undefined)
          recordMessage(db, bot.id, { from: "bot", text: result.text, at: Date.now() });
        item.resolve(result);
      }, item.reject)
      .finally(() => {
        headlessRuns.delete(bot.id);
        deps.announceBots();
        if (ownSession === undefined) deps.headlessDone(bot.id);
        else deps.wake();
      });
  }

  return {
    execute(job) {
      const { promise, resolve, reject } = Promise.withResolvers<RoutineTurnResult>();
      const item: QueuedRoutine = { job, resolve, reject };
      routineQueue.push(item);
      deps.wake();
      return {
        done: promise,
        stop: (reason) => {
          if (item.stop) return item.stop(reason);
          routineQueue = routineQueue.filter((i) => i !== item);
          reject(new Error(reason));
        },
      };
    },
    headless: (botId) => {
      const run = headlessRuns.get(botId);
      return run?.ownSession === undefined ? run?.routine : undefined;
    },
    headlessRun(botId) {
      const run = headlessRuns.get(botId);
      return run && { runId: run.runId, sessionId: run.ownSession };
    },
    startReady(chatOf, runInChat) {
      for (const item of routineQueue) {
        const botId = item.job.bot.id;
        const chat = chatOf(botId);
        if (headlessRuns.has(botId) || (item.job.ownSession === undefined && chat?.busy)) continue;
        routineQueue = routineQueue.filter((i) => i !== item);
        if (!chat || item.job.ownSession !== undefined) {
          startHeadless(item);
          continue;
        }
        const turn = runInChat(chat, item.job);
        item.stop = turn.stop;
        void turn.done.then((r) =>
          r instanceof Error ? item.reject(r) : item.resolve({ text: r.text, usage: r.usage }),
        );
      }
    },
  };
}
