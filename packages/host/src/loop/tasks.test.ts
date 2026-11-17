import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import type { ServerEvent } from "@tomte/contract/events";

import { migrate } from "../platform/db.ts";
import { createLoopStore, type LoopTask, type SessionLog } from "./store.ts";
import {
  DISPATCH_TIMEOUT_MS,
  MAX_DISPATCHES,
  Tasks,
  findingsOf,
  foldTasks,
  taskEvent,
} from "./tasks.ts";

let log: SessionLog;
let tasks: Tasks;
let clock: number;
let sent: string[];
let emitted: ServerEvent[];
/** The timers the queue started: running ones fire by hand with `tick()`. */
let timers: { fn: () => void; ms: number; stopped: boolean }[];

const create = (maxParallel = 3) =>
  new Tasks({
    log,
    maxParallel,
    dispatch: (m) => sent.push(m),
    emit: (e) => emitted.push(e),
    now: () => clock,
    every: (fn, ms) => {
      const timer = { fn, ms, stopped: false };
      timers.push(timer);
      return () => {
        timer.stopped = true;
      };
    },
  });

beforeEach(() => {
  log = createLoopStore(migrate(new Database(":memory:"))).session("bot", "s");
  clock = 1000;
  sent = [];
  emitted = [];
  timers = [];
  tasks = create();
});

const running = (taskId: string, startedAt = clock) =>
  log.putTask({ taskId, goal: `goal ${taskId}`, status: "running", startedAt }, startedAt);
const queue = (goal: string, after: string | null = null, agent = "researcher") => {
  const r = tasks.queue(goal, agent, after);
  if (!r.ok) throw new Error(r.error);
  return r.id;
};
const liveTimers = () => timers.filter((t) => !t.stopped);

describe("queue", () => {
  test("stores a queued task with its agent type and what it waits for, and shows it", () => {
    running("a");
    const id = queue("write it up", "a", "worker");

    expect(id).toMatch(/^q-[0-9a-f]{8}$/);
    expect(log.getTask(id)).toMatchObject({
      status: "queued",
      goal: "write it up",
      agentType: "worker",
      after: "a",
      startedAt: 1000,
    });
    expect(emitted).toMatchObject([{ type: "task", taskId: id, state: "queued", after: "a" }]);
  });

  test("refuses to wait for a task that does not exist, and waits for nothing when the task has ended", () => {
    expect(tasks.queue("x", "researcher", "ghost")).toEqual({
      ok: false,
      error: "No task with id ghost. Use an id from <work_state>, or null.",
    });
    running("done");
    log.setStatus("done", "done", 1100);
    const id = queue("then this", "done");

    expect(log.getTask(id)?.after).toBeUndefined();
    expect(log.tasks().map((t) => t.taskId)).toEqual(["done", id]);
  });

  test("an entry that is due at once is handed to the front at once", () => {
    const id = queue("now");
    expect(sent).toEqual([`Start queued task ${id} (agent: researcher): now`]);
  });
});

describe("due", () => {
  test("lists queue entries in the order they were queued, as many as there are free slots, counting an interrupted task as holding one", () => {
    tasks = create(3);
    running("r");
    log.putTask({ taskId: "i", goal: "i", status: "interrupted", startedAt: 1 }, 1);
    // Both slots taken but one: the first entry gets it.
    log.putTask({ taskId: "q-1", goal: "first", status: "queued", startedAt: 10 }, 10);
    log.putTask({ taskId: "q-2", goal: "second", status: "queued", startedAt: 20 }, 20);
    log.putTask({ taskId: "q-0", goal: "zeroth", status: "queued", startedAt: 5 }, 5);

    expect(tasks.due().map((t) => t.taskId)).toEqual(["q-0"]);
  });

  test("holds an entry back while the task it follows is not over, and releases it when that task ends, fails or is cancelled", () => {
    for (const end of ["done", "failed", "cancelled"] as const) {
      log = createLoopStore(migrate(new Database(":memory:"))).session("bot", end);
      tasks = create();
      running("blocker");
      log.putTask(
        { taskId: "q-1", goal: "after", status: "queued", startedAt: 10, after: "blocker" },
        10,
      );
      expect(tasks.due()).toEqual([]);

      log.setStatus("blocker", end, 2000);
      expect(tasks.due().map((t) => t.taskId)).toEqual(["q-1"]);
    }
  });

  test("an interrupted blocker is not over", () => {
    log.putTask({ taskId: "b", goal: "b", status: "interrupted", startedAt: 1 }, 1);
    log.putTask({ taskId: "q-1", goal: "a", status: "queued", startedAt: 2, after: "b" }, 2);
    expect(tasks.due()).toEqual([]);
  });

  test("a blocker the log does not have any more does not hold an entry back", () => {
    log.putTask({ taskId: "q-1", goal: "a", status: "queued", startedAt: 2, after: "gone" }, 2);
    expect(tasks.due().map((t) => t.taskId)).toEqual(["q-1"]);
  });

  test("an entry the front was asked to start holds its slot until the request times out", () => {
    tasks = create(1);
    const first = queue("first");
    const second = queue("second");
    expect(sent).toHaveLength(1);
    expect(tasks.due()).toEqual([]);

    clock += DISPATCH_TIMEOUT_MS;
    expect(tasks.due()).toEqual([]);
    clock += 1;
    expect(tasks.due().map((t) => t.taskId)).toEqual([first]);
    expect(second).not.toBe(first);
  });
});

describe("awaiting", () => {
  test("counts the entries the front was asked to start until the dispatch timeout passes", () => {
    const id = queue("first");
    expect(tasks.awaiting()).toBe(1);
    expect(sent).toHaveLength(1);

    clock += DISPATCH_TIMEOUT_MS;
    expect(tasks.awaiting()).toBe(1);
    clock += 1;
    expect(tasks.awaiting()).toBe(0);

    tasks.started(id, "agent-1");
    expect(tasks.awaiting()).toBe(0);
  });

  test("an entry that waits for a blocker is not asked of the front yet", () => {
    running("a");
    queue("later", "a");
    expect(tasks.awaiting()).toBe(0);
  });
});

describe("pump", () => {
  test("asks again once the request timed out, and fails the task when the front still has not started it after the last attempt", () => {
    const id = queue("stuck");
    expect(sent).toHaveLength(1);

    tasks.pump();
    expect(sent).toHaveLength(1);

    for (let attempt = 2; attempt <= MAX_DISPATCHES; attempt++) {
      clock += DISPATCH_TIMEOUT_MS + 1;
      tasks.pump();
      expect(sent).toHaveLength(attempt);
    }
    expect(log.getTask(id)?.status).toBe("queued");

    clock += DISPATCH_TIMEOUT_MS + 1;
    emitted.length = 0;
    tasks.pump();
    expect(sent).toHaveLength(MAX_DISPATCHES);
    expect(log.getTask(id)).toMatchObject({ status: "failed", endedAt: clock });
    expect(emitted).toMatchObject([{ type: "task", taskId: id, state: "failed" }]);
    // Nothing is left to ask for.
    expect(liveTimers()).toEqual([]);
  });

  test("a failed entry frees the slot for the next one in the same pass", () => {
    tasks = create(1);
    const first = queue("first");
    const second = queue("second");
    expect(sent).toHaveLength(1);
    for (let i = 1; i <= MAX_DISPATCHES; i++) {
      clock += DISPATCH_TIMEOUT_MS + 1;
      tasks.pump();
    }

    expect(log.getTask(first)?.status).toBe("failed");
    // The slot the failure freed is the second one's, on the next pass.
    tasks.pump();
    expect(sent.at(-1)).toContain(second);
  });

  test("starts the queue's timer while something is queued and stops it when nothing is", () => {
    running("a");
    expect(liveTimers()).toEqual([]);
    const id = queue("later", "a");
    expect(liveTimers()).toMatchObject([{ ms: 5000 }]);

    tasks.cancelQueued(id);
    expect(liveTimers()).toEqual([]);
  });

  test("the timer asks for what became due without any task event", () => {
    running("a");
    queue("later", "a");
    expect(sent).toEqual([]);

    log.setStatus("a", "done", 1500);
    liveTimers()[0]?.fn();
    expect(sent).toHaveLength(1);
  });

  test("a queue left over from an earlier run is looked at as soon as the session is opened", () => {
    running("a");
    queue("left over", "a");
    tasks.dispose();
    expect(liveTimers()).toEqual([]);

    const reopened = create();
    expect(liveTimers()).toHaveLength(1);
    reopened.dispose();
    expect(liveTimers()).toEqual([]);
  });

  test("a disposed queue asks for nothing", () => {
    running("a");
    queue("later", "a");
    tasks.dispose();
    log.setStatus("a", "done", 1500);
    tasks.pump();
    expect(sent).toEqual([]);
  });
});

describe("cancelQueued", () => {
  test("drops a queued task and tells the page, and does not ask the front for it", () => {
    running("a");
    const id = queue("later", "a");
    emitted.length = 0;

    expect(tasks.cancelQueued(id)).toEqual({ ok: true, id });
    expect(log.getTask(id)?.status).toBe("cancelled");
    expect(emitted).toMatchObject([{ type: "task", state: "cancelled" }]);

    log.setStatus("a", "done", 2000);
    tasks.pump();
    expect(sent).toEqual([]);
  });

  test("refuses a task that runs or does not exist, pointing at TaskStop", () => {
    running("a");
    for (const id of ["a", "nope"])
      expect(tasks.cancelQueued(id)).toEqual({
        ok: false,
        error: `No queued task with id ${id}. Running tasks are stopped with TaskStop.`,
      });
  });

  test("cancelAllQueued drops every queued task but leaves running ones", () => {
    running("a");
    queue("one", "a");
    queue("two", "a");
    tasks.cancelAllQueued();

    expect(log.tasks().map((t) => t.status)).toEqual(["running", "cancelled", "cancelled"]);
  });
});

describe("claim and started", () => {
  test("an Agent call claims the dispatched entry it names by name, description or prompt", () => {
    const id = queue("go");
    expect(tasks.claim({ name: id })).toBe(id);
    expect(tasks.claim({ description: `do ${id}` })).toBe(id);
    expect(tasks.claim({ prompt: `Task ${id}: ...` })).toBe(id);
    expect(tasks.claim({ name: "q-other", description: "go", prompt: "go" })).toBeUndefined();
  });

  test("only an entry the front was asked for can be claimed", () => {
    running("a");
    const id = queue("later", "a");
    expect(tasks.claim({ name: id })).toBeUndefined();
  });

  test("started removes the entry, points what waited for it at the agent and remembers the id it became", () => {
    const first = queue("first");
    log.putTask(
      { taskId: "q-2", goal: "second", status: "queued", startedAt: 2000, after: first },
      2000,
    );

    expect(tasks.started(first, "agent-1")?.goal).toBe("first");
    expect(log.getTask(first)).toBeUndefined();
    expect(log.getTask("q-2")?.after).toBe("agent-1");
    expect(tasks.resolve(first)).toBe("agent-1");
    expect(tasks.resolve("other")).toBe("other");
    expect(tasks.claim({ name: first })).toBeUndefined();
  });

  test("started does nothing for an entry that is not queued any more", () => {
    const id = queue("go");
    tasks.cancelQueued(id);
    expect(tasks.started(id, "agent-1")).toBeUndefined();
    expect(log.getTask(id)?.status).toBe("cancelled");
  });

  test("a task that waits for a queue entry waits for the agent it became", () => {
    running("a");
    const first = queue("first", "a");
    const second = queue("second", first);
    log.setStatus("a", "done", 1500);
    tasks.pump();
    expect(sent).toEqual([`Start queued task ${first} (agent: researcher): first`]);

    tasks.started(first, "agent-1");
    log.putTask({ taskId: "agent-1", goal: "first", status: "running", startedAt: 1600 }, 1600);
    expect(tasks.due()).toEqual([]);

    log.setStatus("agent-1", "done", 1700);
    expect(tasks.due().map((t) => t.taskId)).toEqual([second]);
  });

  test("queueing after an entry that has started follows the agent", () => {
    const first = queue("first");
    tasks.started(first, "agent-1");
    log.putTask({ taskId: "agent-1", goal: "first", status: "running", startedAt: 1100 }, 1100);

    expect(log.getTask(queue("next", first))?.after).toBe("agent-1");
  });
});

describe("foldTasks", () => {
  const t = (taskId: string, status: LoopTask["status"], extra: Partial<LoopTask> = {}) => ({
    taskId,
    goal: taskId,
    status,
    startedAt: 1,
    updatedAt: 1,
    ...extra,
  });

  test("groups what holds a slot, what waits and what ended, oldest end first", () => {
    const view = foldTasks([
      t("run", "running"),
      t("int", "interrupted"),
      t("q", "queued", { after: "run", agentType: "worker" }),
      t("late", "done", { endedAt: 30 }),
      t("early", "failed", { endedAt: 20 }),
      t("cut", "cancelled", { endedAt: 25 }),
    ]);

    expect(view.running.map((x) => x.taskId)).toEqual(["run", "int"]);
    expect(view.queued).toMatchObject([{ taskId: "q", after: "run", agentType: "worker" }]);
    expect(view.ended.map((x) => x.taskId)).toEqual(["early", "cut", "late"]);
  });

  test("adds what the caller knows about the tasks that hold a slot, and nothing to the others", () => {
    const view = foldTasks([t("run", "running"), t("q", "queued")], () => ({
      line: "Reading",
      findings: ["F"],
      steers: 2,
    }));
    expect(view.running[0]).toMatchObject({ line: "Reading", findings: ["F"], steers: 2 });
    expect(view.queued[0]).not.toHaveProperty("findings");
  });

  test("a queued task that waits for nothing says so", () => {
    expect(foldTasks([t("q", "queued")]).queued[0]?.after).toBeNull();
  });
});

describe("what the page is shown", () => {
  test("a task event carries the wait and the findings only when there are some", () => {
    const base: LoopTask = { taskId: "a", goal: "g", status: "queued", startedAt: 1, updatedAt: 1 };
    expect(taskEvent(base)).toEqual({
      type: "task",
      taskId: "a",
      goal: "g",
      state: "queued",
      startedAt: 1,
    });
    expect(taskEvent({ ...base, after: "b", endedAt: 5 }, ["f"])).toMatchObject({
      after: "b",
      endedAt: 5,
      findings: ["f"],
    });
  });

  test("findings are the findings of the progress records, tidied, newest last, at most eight", () => {
    log.append({
      kind: "progress",
      taskId: "a",
      at: 1,
      progress: { phase: "p", finding: null, next: "n" },
    });
    for (let i = 1; i <= 10; i++)
      log.append({
        kind: "progress",
        taskId: "a",
        at: i,
        progress: { phase: "p", finding: `f${i}  \n x`, next: "n" },
      });
    log.append({
      kind: "progress",
      taskId: "b",
      at: 1,
      progress: { phase: "p", finding: "other", next: "n" },
    });

    expect(findingsOf(log, "a")).toEqual(Array.from({ length: 8 }, (_, i) => `f${i + 3} x`));
  });
});
