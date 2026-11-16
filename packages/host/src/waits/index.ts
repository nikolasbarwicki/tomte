import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { ServerEvent, WaitAction } from "@claudebot/contract/events";

import { createWaitStore, type Wait, type WaitKind, type WaitPayloads } from "./store.ts";

export type { Wait, WaitKind } from "./store.ts";

/** What the bot's tool returns for a human wait: at once, never after the user answers. */
export interface WaitingForUser {
  status: "waiting_for_user";
  id: string;
}

/** How a wait can end without one of its buttons or an answer. A takeover's `timeout` is its own inactivity limit. */
type WaitOutcome = "timeout" | "expired" | "cancelled";

/** Every wait expires this long after it opened. */
const WAIT_EXPIRY_MS = 24 * 60 * 60_000;

const SWEEP_MS = 60_000;

export interface WaitSpec<K extends WaitKind = WaitKind> {
  kind: K;
  payload: WaitPayloads[K];
  /** The buttons of a card, first is the main one; a question has none. */
  actions: WaitAction[];
  /** The routine run the wait belongs to; omitted for an attended wait. */
  runId?: string;
}

/** What one kind of wait does, working from the stored row alone so a wait can be resumed after a restart. */
interface WaitHandler<K extends WaitKind> {
  /** The card of an open wait. */
  card(w: Wait<K>): ServerEvent;
  /** What closes the card once the wait is no longer open (`w.state`, `w.outcome`). */
  closing(w: Wait<K>): ServerEvent;
  /** Names the request in the messages for a wait the host cancelled or let expire. */
  subject(w: Wait<K>): string;
  /** What the bot is told when the wait was answered, or ended as `timeout`. */
  answered(w: Wait<K>): string;
  /** True for a wait that ends without an answer and tells nobody, such as a question about an external event whose turn ended. */
  silent?(w: Wait<K>): boolean;
  /** Runs when the wait closes, whatever the way, before the bot is told. */
  onResolve?(w: Wait<K>): void;
}

/** A wait opening or closing, for a channel to follow. */
type WaitEvent = { type: "opened" | "closed"; wait: Wait };

export interface WaitsOptions {
  db: Database;
  /** Shows or updates a card in the bot's chat. */
  emit(botId: string, e: ServerEvent): void;
  /** Sends a host message into the bot's session through the normal send path: queued while the bot is busy, reopening a closed session. */
  deliver(botId: string, text: string): void;
  /**
   * Hands a closed wait to the tool call still waiting for it in this process, with the text the bot would have been sent.
   * True when one took it, so the bot gets no message. Without it every closed wait is delivered as a message.
   */
  claim?(wait: Wait, text: string): boolean;
  /**
   * What a wait opened for this bot now belongs to: the session it is in and, while an unattended routine turn runs, that run's id.
   * A wait with a run id is never delivered as a message by this module; the run decides when the bot hears it (`ofRun`).
   */
  context?(
    botId: string,
  ): { sessionId?: string | undefined; runId?: string | undefined } | undefined;
  /** The clock expiry reads, in epoch milliseconds; the system clock when omitted. */
  now?: () => number;
}

/**
 * Every human wait a bot raises: a tool approval, an `ask_user` question, a takeover and a credential approval. Each is a row in
 * `human_waits`, so an open wait survives a restart; the card shows in the bot's chat and closes with its answer, and the bot hears
 * the outcome either through the tool call still waiting for it or as a `<human-wait-result>` message.
 */
export interface Waits {
  /** Says what a kind shows and does; the browser registers `takeover` and `credential`, the module itself `tool_approval` and `question`. */
  register<K extends WaitKind>(kind: K, handler: WaitHandler<NoInfer<K>>): void;
  /** Stores the wait, shows its card and returns at once. */
  open<K extends WaitKind>(botId: string, spec: WaitSpec<K>): WaitingForUser;
  /** The user's answer: a button's id, or any text for a question, with an optional note for the bot. False when the wait is gone, overdue, or `value` is not one of its buttons. */
  answer(id: string, value: string, note?: string): boolean;
  /** Ends an open wait for a reason that is not an answer; `reason` tells the bot why. False when the wait is gone. */
  resolve(id: string, outcome: WaitOutcome, reason?: string): boolean;
  /** Cancels every open wait of a bot and tells it why. Returns how many were open. */
  cancelBot(botId: string, reason: string): number;
  /** The open wait with this id. */
  find(id: string): Wait | undefined;
  /** Open waits, oldest first; every bot's when `botId` is omitted. */
  list(botId?: string): Wait[];
  /** Told when a wait opens and when it closes. */
  subscribe(listener: (e: WaitEvent) => void): () => void;
  /** The cards of a bot's open waits, to replay into a rebuilt chat. */
  cards(botId: string): ServerEvent[];
  /** Allows a tool call once when the user approved exactly this input and no call has used that approval yet. */
  consumeApproval(botId: string, tool: string, input: Record<string, unknown>): boolean;
  /** Cancels every open wait of a routine run without telling the bot, as the run ended. Returns how many were open. */
  cancelRun(runId: string, reason: string): number;
  /** A run's waits that are open, or closed with an outcome the run has not yet given the bot, oldest first. */
  ofRun(runId: string): Wait[];
  /** What the bot is told for these closed waits: one `<human-wait-result>` block each, in the order given. */
  resultText(waits: Wait[]): string;
  /** Records that the run has given the bot the outcome of these waits. */
  delivered(waits: Wait[]): void;
  /** Deletes a bot's waits, open or closed. */
  removeBot(botId: string): void;
  /** Cancels what a restart left unanswerable, expires what is overdue and keeps sweeping. Call once every kind has its handler. */
  start(): void;
  close(): void;
}

/** An input as JSON with the keys of every object in order, so two inputs compare equal exactly when they hold the same data. */
export function canonicalInput(input: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(input));
}

/** The event that closes a `wait` card. */
export function waitResolvedCard(w: Wait): ServerEvent {
  const label =
    w.actions.find((a) => a.id === w.outcome)?.label ??
    (w.outcome === "cancelled" ? "Cancelled" : w.outcome === "expired" ? "Expired" : "Timed out");
  return { type: "wait_resolved", id: w.id, label };
}

const quote = (s: string) => `"${s.length > 120 ? `${s.slice(0, 119)}…` : s}"`;

const approval: WaitHandler<"tool_approval"> = {
  card: (w) => ({
    type: "approve",
    id: w.id,
    tool: w.payload.tool,
    reason: w.payload.reason,
    input: JSON.stringify(w.payload.input, null, 2),
  }),
  closing: (w) => ({
    type: "answered",
    id: w.id,
    value: w.state === "answered" ? (w.outcome ?? "") : (w.outcome ?? w.state),
  }),
  subject: (w) => `approval to use ${w.payload.tool}`,
  answered: (w) =>
    w.outcome === "allow"
      ? `The user allowed ${w.payload.tool} for exactly this input: ${w.payload.canonical}. Call ${w.payload.tool} again with exactly that input; a call with any other input asks again.`
      : `The user denied ${w.payload.tool}. Do not retry it; continue without it or report what is blocked.`,
};

const question: WaitHandler<"question"> = {
  card: (w) => ({
    type: "ask",
    id: w.id,
    question: w.payload.question,
    ...(w.payload.options && { options: w.payload.options }),
    ...(w.payload.eventId && { eventId: w.payload.eventId }),
  }),
  closing: (w) =>
    w.state === "answered"
      ? { type: "answered", id: w.id, value: w.outcome ?? "" }
      : { type: "ask_expired", id: w.id },
  subject: (w) => `question ${quote(w.payload.question)}`,
  answered: (w) => `The user answered your question ${quote(w.payload.question)}: ${w.outcome}`,
  silent: (w) => w.state !== "answered" && w.payload.eventId !== undefined,
};

export function createWaits(o: WaitsOptions): Waits {
  const store = createWaitStore(o.db);
  const now = o.now ?? Date.now;
  const handlers = new Map<WaitKind, WaitHandler<never>>([
    ["tool_approval", approval],
    ["question", question],
  ]);
  const listeners = new Set<(e: WaitEvent) => void>();
  let sweeper: ReturnType<typeof setInterval> | undefined;

  const handlerOf = (kind: WaitKind) => {
    const h = handlers.get(kind);
    if (!h) throw new Error(`no handler for the "${kind}" wait kind`);
    return h as unknown as WaitHandler<WaitKind>;
  };
  const tell = (e: WaitEvent) => {
    for (const l of listeners) l(e);
  };

  /** What the bot is told, whichever way the wait closed. */
  function textFor(w: Wait, h: WaitHandler<WaitKind>): string {
    if (w.outcome === "cancelled")
      return `Your pending ${h.subject(w)} was cancelled: ${w.note ?? "no reason given"}. Do not wait for it.`;
    if (w.outcome === "expired")
      return `Your pending ${h.subject(w)} expired after 24 hours without an answer; nothing was approved. Do not retry it.`;
    const text = h.answered(w);
    return w.note ? `${text}\nThe user's note: ${w.note}` : text;
  }

  /** The `<human-wait-result>` block the bot is sent for a closed wait. */
  const block = (w: Wait) =>
    `<human-wait-result id="${w.id}">\n${textFor(w, handlerOf(w.kind))}\n</human-wait-result>`;

  function finish(
    id: string,
    state: "answered" | "expired" | "cancelled",
    outcome: string,
    note?: string,
  ): boolean {
    if (!store.close(id, state, outcome, note, now())) return false;
    const w = store.get(id)!;
    const h = handlerOf(w.kind);
    o.emit(w.botId, h.closing(w));
    h.onResolve?.(w);
    // A run's wait is told to the run, which subscribes to the close below and gives the bot every outcome of the park in one message.
    if (w.runId === null) {
      const text = textFor(w, h);
      const claimed = o.claim?.(w, text) ?? false;
      if (claimed) {
        if (w.kind === "tool_approval" && w.outcome === "allow") store.markConsumed(w.id, now());
      } else if (!h.silent?.(w)) o.deliver(w.botId, block(w));
    }
    tell({ type: "closed", wait: store.get(id)! });
    return true;
  }

  function sweep() {
    for (const w of store.overdue(now())) finish(w.id, "expired", "expired");
  }

  return {
    register(kind, handler) {
      handlers.set(kind, handler as unknown as WaitHandler<never>);
    },
    open(botId, spec) {
      const id = randomUUID();
      const createdAt = now();
      const context = o.context?.(botId);
      handlerOf(spec.kind);
      store.insert({
        id,
        botId,
        kind: spec.kind,
        runId: spec.runId ?? context?.runId ?? null,
        sessionId: context?.sessionId ?? null,
        payload: spec.payload,
        actions: spec.actions,
        createdAt,
        expiresAt: createdAt + WAIT_EXPIRY_MS,
      });
      const w = store.get(id)!;
      o.emit(botId, handlerOf(w.kind).card(w));
      tell({ type: "opened", wait: w });
      return { status: "waiting_for_user", id };
    },
    answer(id, value, note) {
      const w = store.get(id);
      if (w?.state !== "open") return false;
      if (w.expiresAt <= now()) {
        finish(id, "expired", "expired");
        return false;
      }
      if (w.kind !== "question" && !w.actions.some((a) => a.id === value)) return false;
      return finish(id, "answered", value, note);
    },
    resolve(id, outcome, reason) {
      // A takeover's `timeout` counts as the user's Skip: the run goes on, so it is an answer, not the 24-hour expiry that fails a run.
      const state =
        outcome === "cancelled" ? "cancelled" : outcome === "timeout" ? "answered" : "expired";
      return finish(id, state, outcome, reason);
    },
    cancelBot(botId, reason) {
      const open = store.open(botId);
      for (const w of open) finish(w.id, "cancelled", "cancelled", reason);
      return open.length;
    },
    cancelRun(runId, reason) {
      const open = store.ofRun(runId).filter((w) => w.state === "open");
      for (const w of open) finish(w.id, "cancelled", "cancelled", reason);
      return open.length;
    },
    ofRun: (runId) => store.ofRun(runId),
    resultText: (waits) => waits.map(block).join("\n\n"),
    delivered: (waits) =>
      store.markDelivered(
        waits.map((w) => w.id),
        now(),
      ),
    find(id) {
      const w = store.get(id);
      return w?.state === "open" ? w : undefined;
    },
    list: (botId) => store.open(botId),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    cards: (botId) =>
      store
        .open(botId)
        .filter((w) => handlers.has(w.kind))
        .map((w) => handlerOf(w.kind).card(w)),
    consumeApproval: (botId, tool, input) =>
      store.consumeAllowance(botId, tool, canonicalInput(input), now()),
    removeBot: (botId) => store.removeBot(botId),
    start() {
      for (const w of store.open()) {
        if (w.kind === "takeover")
          finish(
            w.id,
            "cancelled",
            "cancelled",
            "the host restarted and the browser session is gone; request the takeover again if you still need it",
          );
        else if (w.kind === "question" && w.payload.eventId !== undefined)
          finish(w.id, "cancelled", "cancelled", "its turn ended when the host restarted");
      }
      sweep();
      sweeper ??= setInterval(sweep, SWEEP_MS);
      sweeper.unref();
    },
    close() {
      clearInterval(sweeper);
      sweeper = undefined;
    },
  };
}
