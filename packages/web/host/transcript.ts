import type {
  Attachment,
  ExternalEventState,
  HandoffStatus,
  Relay,
  ServerEvent,
  TaskState,
  WaitAction,
} from "@tomte/contract/events";

import { kTokens } from "@/lib/format.ts";

export type Item =
  | {
      kind: "user";
      text: string;
      mentions?: { id: string; name: string }[] | undefined;
      attachments?: Attachment[] | undefined;
    }
  /** A message sent while the bot was busy; shown below the live thread until it runs or is cancelled. */
  | {
      kind: "queued";
      id: string;
      text: string;
      mentions?: { id: string; name: string }[] | undefined;
      attachments?: Attachment[] | undefined;
    }
  | { kind: "assistant" | "error" | "info"; text: string }
  | { kind: "tool"; name: string; input: string }
  | {
      kind: "ask";
      id: string;
      question: string;
      options?: string[];
      /** The external needs-you item the question is about; that item is in the Needs you bar already. */
      eventId?: string;
      answer?: string;
      /** Its turn ended before an answer: nobody is waiting for one any more. */
      expired?: true;
    }
  | {
      kind: "approve";
      id: string;
      tool: string;
      reason: string;
      input: string;
      actions: WaitAction[];
      answer?: string;
    }
  | {
      kind: "wait";
      id: string;
      waitKind: string;
      title: string;
      detail?: string | undefined;
      actions: WaitAction[];
      resolved?: string;
    }
  | { kind: "session" }
  | { kind: "routine"; name: string; trigger: string }
  | {
      kind: "handoff";
      direction: "sent" | "received";
      bot: string;
      botId?: string | undefined;
      title: string;
      status: HandoffStatus;
      text: string;
    }
  | {
      kind: "external";
      id: string;
      source: string;
      eventKind: Extract<ServerEvent, { type: "external" }>["kind"];
      title: string;
      state: ExternalEventState;
      /** Whether the answer reached the sender's agent; only for items that name a reply target. */
      relay?: Relay | undefined;
    }
  /** A background task of a double-loop bot: where it stands and, while it runs, its live status line; `findings` are what its agent verified, newest last, and `after` is the task a queued one waits for. */
  | {
      kind: "task";
      taskId: string;
      goal: string;
      state: TaskState;
      startedAt: number;
      endedAt?: number | undefined;
      agentType?: string | undefined;
      after?: string | undefined;
      findings?: string[] | undefined;
      status?: string | undefined;
    }
  /** A background task's result, shown as the bot's own message; `task` is the goal of the task that produced it, when known. */
  | { kind: "report"; taskId: string; text: string; task?: string | undefined };

export function reduce(items: Item[], e: ServerEvent): Item[] {
  if (e.type === "queued")
    return [
      ...items,
      { kind: "queued", id: e.id, text: e.text, mentions: e.mentions, attachments: e.attachments },
    ];
  if (e.type === "dequeued") return items.filter((i) => !(i.kind === "queued" && i.id === e.id));
  // Queued messages stay after the live thread, so output that arrives while they wait carries on from the item before them.
  const queued = items.filter((i) => i.kind === "queued");
  if (queued.length === 0) return reduceLive(items, e);
  return [
    ...reduceLive(
      items.filter((i) => i.kind !== "queued"),
      e,
    ),
    ...queued,
  ];
}

function reduceLive(
  items: Item[],
  e: Exclude<ServerEvent, { type: "queued" | "dequeued" }>,
): Item[] {
  const last = items[items.length - 1];
  switch (e.type) {
    case "user":
      return [
        ...items,
        { kind: "user", text: e.text, mentions: e.mentions, attachments: e.attachments },
      ];
    case "text_start":
      return [...items, { kind: "assistant", text: "" }];
    case "delta":
      return last?.kind === "assistant"
        ? [...items.slice(0, -1), { ...last, text: last.text + e.text }]
        : [...items, { kind: "assistant", text: e.text }];
    case "tool":
      return [...items, { kind: "tool", name: e.name, input: e.input }];
    case "ask":
      return [
        ...items,
        {
          kind: "ask",
          id: e.id,
          question: e.question,
          ...(e.options && { options: e.options }),
          ...(e.eventId && { eventId: e.eventId }),
        },
      ];
    case "approve":
      return [
        ...items,
        {
          kind: "approve",
          id: e.id,
          tool: e.tool,
          reason: e.reason,
          input: e.input,
          actions: e.actions,
        },
      ];
    case "answered":
      return items.map((i) =>
        (i.kind === "ask" || i.kind === "approve") && i.id === e.id ? { ...i, answer: e.value } : i,
      );
    case "ask_expired":
      return items.map((i) => (i.kind === "ask" && i.id === e.id ? { ...i, expired: true } : i));
    case "wait":
      return [
        ...items,
        {
          kind: "wait",
          id: e.id,
          waitKind: e.kind,
          title: e.title,
          detail: e.detail,
          actions: e.actions,
        },
      ];
    case "wait_resolved":
      return items.map((i) =>
        i.kind === "wait" && i.id === e.id ? { ...i, resolved: e.label } : i,
      );
    case "error":
      return [...items, { kind: "error", text: e.message }];
    case "info":
      return [...items, { kind: "info", text: e.text }];
    case "session":
      return [...items, { kind: "session" }];
    case "routine":
      return [...items, { kind: "routine", name: e.name, trigger: e.trigger }];
    case "handoff":
      return [
        ...items,
        {
          kind: "handoff",
          direction: e.direction,
          bot: e.bot,
          botId: e.botId,
          title: e.title,
          status: e.status,
          text: e.text,
        },
      ];
    case "external":
      return [
        ...items,
        {
          kind: "external",
          id: e.id,
          source: e.source,
          eventKind: e.kind,
          title: e.title,
          state: e.state,
          relay: e.relay,
        },
      ];
    case "external_state":
      return items.map((i) =>
        i.kind === "external" && i.id === e.id ? { ...i, state: e.state, relay: e.relay } : i,
      );
    case "compacted":
      return [
        ...items,
        {
          kind: "info",
          text: `Context compacted (${e.trigger}) · ${kTokens(e.preTokens)} tokens summarized`,
        },
      ];
    case "task":
      return upsertTask(items, e);
    case "task_status":
      return items.map((i) =>
        i.kind === "task" && i.taskId === e.taskId ? { ...i, status: e.text || undefined } : i,
      );
    case "report":
      return [
        ...items,
        {
          kind: "report",
          taskId: e.taskId,
          text: e.text,
          task: taskRow(items, e.taskId)?.goal,
        },
      ];
    case "done":
    case "reset":
    case "context":
    case "presence":
    case "rate_limit":
      return items;
  }
}

/** The row of a task, if the thread has one. */
function taskRow(items: Item[], taskId: string): Extract<Item, { kind: "task" }> | undefined {
  return items.find(
    (i): i is Extract<Item, { kind: "task" }> => i.kind === "task" && i.taskId === taskId,
  );
}

/**
 * A task event is the task's whole state: it replaces the task's row, keeping its place, or adds one. A task that replaces a queue
 * entry (`queuedId`) takes the entry's row, and the queued tasks that waited for the entry wait for it now. A status line outlives
 * only a running task.
 */
function upsertTask(items: Item[], e: Extract<ServerEvent, { type: "task" }>): Item[] {
  const current =
    taskRow(items, e.taskId) ?? (e.queuedId === undefined ? undefined : taskRow(items, e.queuedId));
  const row: Item = {
    kind: "task",
    taskId: e.taskId,
    goal: e.goal,
    state: e.state,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    agentType: e.agentType,
    after: e.after,
    findings: e.findings,
    status: e.state === "running" ? current?.status : undefined,
  };
  const next = current ? items.map((i) => (i === current ? row : i)) : [...items, row];
  if (e.queuedId === undefined) return next;
  return next.map((i) =>
    i.kind === "task" && i.after === e.queuedId ? { ...i, after: e.taskId } : i,
  );
}
