import type { Database } from "bun:sqlite";

import { recordMessage, type ThreadEnv, type TurnResult } from "../bots/index.ts";
import { parkingDelegate, runHeadless, type Executor, type RoutineJob } from "../routines/index.ts";
import type { Waits } from "../waits/index.ts";

/** A routine turn waiting for its bot; it runs in the bot's chat once that is idle, or headless if the bot has no chat. */
type QueuedRoutine = {
  job: RoutineJob;
  resolve(text: string): void;
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
  /** A headless run ended; the bot's chat, if any, may now show it. */
  headlessDone(botId: string): void;
  /** Something queued; start whatever can run. */
  wake(): void;
}

export interface RoutineTurns {
  execute: Executor;
  /** The routine a headless run is writing the bot's session for; that bot's chat must not start its own turn meanwhile. */
  headless(botId: string): string | undefined;
  /** The run id of the bot's headless run, if one is writing its session. */
  headlessRun(botId: string): string | undefined;
  /** Starts every queued routine whose bot is free: in the bot's chat when it has one, headless otherwise. */
  startReady<C extends { busy: boolean }>(
    chatOf: (botId: string) => C | undefined,
    runInChat: (chat: C, job: RoutineJob) => ChatRoutineTurn,
  ): void;
}

export function createRoutineTurns(deps: RoutineTurnsDeps): RoutineTurns {
  const { db } = deps;
  let routineQueue: QueuedRoutine[] = [];
  const headlessRuns = new Map<string, { routine: string; runId: string }>();

  function startHeadless(item: QueuedRoutine) {
    const { bot, routine } = item.job;
    const h = runHeadless(deps, item.job, parkingDelegate(deps.waits, bot.id));
    item.stop = h.stop;
    headlessRuns.set(bot.id, { routine: routine.name, runId: item.job.runId });
    deps.announceBots();
    h.done
      .then((text) => {
        if (text.trim()) recordMessage(db, bot.id, { from: "bot", text, at: Date.now() });
        item.resolve(text);
      }, item.reject)
      .finally(() => {
        headlessRuns.delete(bot.id);
        deps.announceBots();
        deps.headlessDone(bot.id);
      });
  }

  return {
    execute(job) {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
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
    headless: (botId) => headlessRuns.get(botId)?.routine,
    headlessRun: (botId) => headlessRuns.get(botId)?.runId,
    startReady(chatOf, runInChat) {
      for (const item of routineQueue) {
        const botId = item.job.bot.id;
        const chat = chatOf(botId);
        if (headlessRuns.has(botId) || chat?.busy) continue;
        routineQueue = routineQueue.filter((i) => i !== item);
        if (!chat) {
          startHeadless(item);
          continue;
        }
        const turn = runInChat(chat, item.job);
        item.stop = turn.stop;
        void turn.done.then((r) => (r instanceof Error ? item.reject(r) : item.resolve(r.text)));
      }
    },
  };
}
