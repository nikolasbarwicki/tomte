import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { ExternalEventPosted, ExternalEventInput, ReplyTarget } from "@tomte/contract/api";
import {
  WorkSnapshot,
  type Relay,
  type ExternalEventKind,
  type ExternalEventState,
  type FeatureStatus,
  type ServerEvent,
  type SourceEvent,
  type WorkSource,
} from "@tomte/contract/events";

/** A delivered external event as the transcript shows it. */
export type ExternalRow = Extract<ServerEvent, { type: "external" }>;

/** How many events of one source the host keeps: the newest, plus every open event whatever its age. */
const KEPT_EVENTS_PER_SOURCE = 200;
/** How many of a source's newest events the stream carries, plus every open event. */
const TIMELINE_EVENTS = 50;

/** A bot's open needs-you items, as the bots slice reports them. */
export type OpenItems = { count: number; sources: string[]; newestAt: number };

/** A stored external event that is not `progress`, with everything a channel needs to show it: the item behind a card. */
export type EventItem = {
  id: string;
  botId: string;
  kind: Exclude<ExternalEventKind, "progress">;
  /** The source's label. */
  source: string;
  title: string;
  body?: string;
  options: string[];
  receivedAt: number;
  state: ExternalEventState;
};

type EventRow = {
  id: string;
  source_id: string;
  kind: ExternalEventKind;
  title: string;
  body: string | null;
  options: string | null;
  received_at: number;
  state: ExternalEventState;
  relay_state: "none" | Relay["state"];
  relay_attempts: number;
  relay_error: string | null;
};

const relayOf = (r: Pick<EventRow, "relay_state" | "relay_attempts" | "relay_error">) =>
  r.relay_state === "none"
    ? undefined
    : {
        state: r.relay_state,
        attempts: r.relay_attempts,
        ...(r.relay_error !== null && { error: r.relay_error }),
      };

const toSourceEvent = (r: EventRow): SourceEvent => {
  const relay = relayOf(r);
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    ...(r.body !== null && { body: r.body }),
    ...(r.options !== null && { options: JSON.parse(r.options) as string[] }),
    receivedAt: r.received_at,
    state: r.state,
    ...(relay && { relay }),
  };
};

/**
 * A source needs the user while a question is open or one of the host's notices is, is blocked while a blocked report is
 * open, failed while a failure is open, and otherwise shows how its latest event that was not `progress` ended it:
 * `stopped`, or `done` (also for a source whose notices are all closed).
 */
function statusOf(events: SourceEvent[], latest: ExternalEventKind | undefined): FeatureStatus {
  const open = (kind: ExternalEventKind) =>
    events.some((e) => e.state === "open" && e.kind === kind);
  if (open("question") || open("notice")) return "needs_you";
  if (open("blocked")) return "blocked";
  if (open("failed")) return "failed";
  if (latest === "stopped" || latest === "done") return latest;
  return latest === "notice" ? "done" : "running";
}

/** The tables of the events feature: the event sources a bot has heard from, and every external event posted to it. */
export function createEventStore(db: Database) {
  const sourceOf = db.query<unknown, [string, string, string, string | null, number]>(
    `INSERT INTO event_sources (bot_id, source_id, label, work, last_event_at, archived) VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT (bot_id, source_id) DO UPDATE SET
       label = excluded.label,
       work = COALESCE(excluded.work, work),
       last_event_at = excluded.last_event_at,
       archived = 0`,
  );
  const existing = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM external_events WHERE bot_id = ? AND key = ?",
  );
  const insert = db.query<
    unknown,
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      number,
      string,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO external_events (id, bot_id, key, source_id, kind, title, body, options, received_at, state, question_id, reply)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Arrival order is the table's rowid: events posted in the same millisecond still have a newest.
  const prune = db.query<unknown, [string, string, string, string, number]>(
    `DELETE FROM external_events WHERE bot_id = ? AND source_id = ? AND state <> 'open' AND rowid NOT IN (
       SELECT rowid FROM external_events WHERE bot_id = ? AND source_id = ? ORDER BY rowid DESC LIMIT ?
     )`,
  );
  const liveSources = db.query<
    { source_id: string; label: string; work: string | null; last_event_at: number },
    [string]
  >(
    `SELECT source_id, label, work, last_event_at FROM event_sources
     WHERE bot_id = ? AND archived = 0 ORDER BY last_event_at DESC, source_id`,
  );
  const timeline = db.query<EventRow, [string, number]>(
    `SELECT id, source_id, kind, title, body, options, received_at, state, relay_state, relay_attempts, relay_error FROM (
       SELECT rowid AS arrived, *, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY rowid DESC) AS newest
       FROM external_events WHERE bot_id = ?
     ) WHERE newest <= ? OR state = 'open' ORDER BY arrived`,
  );
  const resolveOpen = db.query<{ id: string }, [string, string, string]>(
    `UPDATE external_events SET state = 'resolved'
     WHERE bot_id = ? AND source_id = ? AND state = 'open' AND kind <> 'notice' AND key IN (SELECT value FROM json_each(?))
     RETURNING id`,
  );
  const dismissOpen = db.query<{ id: string }, [string, string]>(
    `UPDATE external_events SET state = 'dismissed' WHERE bot_id = ? AND id = ? AND state = 'open' RETURNING id`,
  );
  const resolveNotices = db.query<{ id: string }, [string, string, string]>(
    `UPDATE external_events SET state = 'resolved'
     WHERE bot_id = ? AND kind = 'notice' AND state = 'open' AND substr(key, 1, length(?)) = ?
     RETURNING id`,
  );
  // The answer's relay: `pending` is entered with the close (so there is exactly one first attempt) or by a retry of a
  // `failed` one, and left by `relayFinish`; only the statement that changes the state starts an attempt.
  const closeAnswered = db.query<{ reply: string | null }, [string, string]>(
    `UPDATE external_events SET state = 'acted' WHERE bot_id = ? AND id = ? AND state = 'open' RETURNING reply`,
  );
  const startRelay = db.query<unknown, [string, string, string]>(
    `UPDATE external_events SET relay_state = 'pending', relay_attempts = 1, relay_error = NULL, relay_answer = ?
     WHERE bot_id = ? AND id = ?`,
  );
  const failRelay = db.query<unknown, [string, string, string]>(
    `UPDATE external_events SET relay_state = 'failed', relay_attempts = 1, relay_error = ?
     WHERE bot_id = ? AND id = ?`,
  );
  const retryRelay = db.query<{ id: string }, [string, string]>(
    `UPDATE external_events SET relay_state = 'pending', relay_attempts = relay_attempts + 1, relay_error = NULL
     WHERE bot_id = ? AND id = ? AND relay_state = 'failed' RETURNING id`,
  );
  const relayStateOf = db.query<{ relay_state: "none" | Relay["state"] }, [string, string]>(
    "SELECT relay_state FROM external_events WHERE bot_id = ? AND id = ? AND kind <> 'progress'",
  );
  const finishRelay = db.query<{ id: string }, [string, string | null, string, string, string]>(
    `UPDATE external_events SET relay_state = ?, relay_error = ?,
       relay_answer = CASE WHEN ? = 'relayed' THEN NULL ELSE relay_answer END
     WHERE bot_id = ? AND id = ? AND relay_state = 'pending' RETURNING id`,
  );
  const relayJob = db.query<
    { reply: string | null; question_id: string | null; relay_answer: string | null },
    [string, string]
  >(
    `SELECT reply, question_id, relay_answer FROM external_events
     WHERE bot_id = ? AND id = ? AND relay_state = 'pending'`,
  );
  const interrupted = db.query<{ bot_id: string; id: string }, [string]>(
    `UPDATE external_events SET relay_state = 'failed', relay_error = ? WHERE relay_state = 'pending'
     RETURNING bot_id, id`,
  );
  const stored = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM external_events WHERE bot_id = ? AND id = ? AND kind <> 'progress'",
  );
  const openItem = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM external_events WHERE bot_id = ? AND id = ? AND state = 'open'",
  );
  const latestKinds = db.query<{ source_id: string; kind: ExternalEventKind }, [string]>(
    `SELECT source_id, kind, MAX(rowid) FROM external_events
     WHERE bot_id = ? AND kind <> 'progress' GROUP BY source_id`,
  );

  const archiveState = db.query<
    { archived: number; open: number },
    [string, string, string, string]
  >(
    `SELECT archived, (SELECT COUNT(*) FROM external_events WHERE bot_id = ? AND source_id = ? AND state = 'open') AS open
     FROM event_sources WHERE bot_id = ? AND source_id = ?`,
  );
  const archiveSource = db.query<unknown, [string, string]>(
    "UPDATE event_sources SET archived = 1 WHERE bot_id = ? AND source_id = ?",
  );

  // Per bot and source, newest source first: a source's newest open event is its highest rowid.
  const openBySource = db.query<
    { bot_id: string; label: string; n: number; newest: number; at: number },
    []
  >(
    `SELECT e.bot_id, s.label, COUNT(*) AS n, MAX(e.rowid) AS newest, MAX(e.received_at) AS at
     FROM external_events e JOIN event_sources s ON s.bot_id = e.bot_id AND s.source_id = e.source_id
     WHERE e.state = 'open' GROUP BY e.bot_id, e.source_id ORDER BY newest DESC`,
  );

  const rowOf = db.query<
    {
      kind: ExternalRow["kind"];
      title: string;
      state: ExternalRow["state"];
      label: string;
      relay_state: "none" | Relay["state"];
      relay_attempts: number;
      relay_error: string | null;
    },
    [string, string]
  >(
    `SELECT e.kind, e.title, e.state, s.label, e.relay_state, e.relay_attempts, e.relay_error
     FROM external_events e JOIN event_sources s ON s.bot_id = e.bot_id AND s.source_id = e.source_id
     WHERE e.bot_id = ? AND e.id = ? AND e.kind NOT IN ('progress', 'notice')`,
  );

  const itemColumns = `e.id, e.bot_id, e.kind, e.title, e.body, e.options, e.received_at, e.state, s.label
     FROM external_events e JOIN event_sources s ON s.bot_id = e.bot_id AND s.source_id = e.source_id`;
  type ItemRow = {
    id: string;
    bot_id: string;
    kind: EventItem["kind"];
    title: string;
    body: string | null;
    options: string | null;
    received_at: number;
    state: ExternalEventState;
    label: string;
  };
  const itemOf = (r: ItemRow): EventItem => ({
    id: r.id,
    botId: r.bot_id,
    kind: r.kind,
    source: r.label,
    title: r.title,
    ...(r.body !== null && { body: r.body }),
    options: r.options === null ? [] : (JSON.parse(r.options) as string[]),
    receivedAt: r.received_at,
    state: r.state,
  });
  const itemById = db.query<ItemRow, [string]>(
    `SELECT ${itemColumns} WHERE e.id = ? AND e.kind != 'progress'`,
  );
  const openItems = db.query<ItemRow, []>(
    `SELECT ${itemColumns} WHERE e.state = 'open' ORDER BY e.rowid`,
  );

  /**
   * Stores one event for a bot unless its key was already seen: the source is created or updated (its label, its last
   * event time, its work snapshot when the event carries one) and a source that was archived is live again. Events
   * past the source's newest 200 are deleted, except open ones. All or nothing. A `progress` event is stored as
   * `info`; every other kind starts `open`. The source's open events named in `resolves` become `resolved` first; a
   * key of another source is not touched. `resolved` lists their ids.
   */
  const record = db.transaction(
    (
      botId: string,
      e: ExternalEventInput,
      at: number,
    ): ExternalEventPosted & { resolved: string[] } => {
      const seen = existing.get(botId, e.key);
      if (seen) return { id: seen.id, duplicate: true, resolved: [] };
      sourceOf.run(botId, e.source.id, e.source.label, e.work ? JSON.stringify(e.work) : null, at);
      const resolved = e.resolves?.length
        ? resolveOpen.all(botId, e.source.id, JSON.stringify(e.resolves)).map((r) => r.id)
        : [];
      const id = randomUUID();
      insert.run(
        id,
        botId,
        e.key,
        e.source.id,
        e.kind,
        e.title,
        e.body ?? null,
        e.options ? JSON.stringify(e.options) : null,
        at,
        e.kind === "progress" ? "info" : "open",
        e.questionId ?? null,
        e.reply ? JSON.stringify(e.reply) : null,
      );
      prune.run(botId, e.source.id, botId, e.source.id, KEPT_EVENTS_PER_SOURCE);
      return { id, duplicate: false, resolved };
    },
  );

  /** The one source the host's own notices come from. */
  const NOTICE_SOURCE = { id: "tomte", label: "Tomte" };
  /** Stores a notice unless its key was seen: a repeated key makes one item. All or nothing. */
  const recordNotice = db.transaction(
    (
      botId: string,
      n: { key: string; title: string; body?: string },
      at: number,
    ): ExternalEventPosted => {
      const seen = existing.get(botId, n.key);
      if (seen) return { id: seen.id, duplicate: true };
      sourceOf.run(botId, NOTICE_SOURCE.id, NOTICE_SOURCE.label, null, at);
      const id = randomUUID();
      insert.run(
        id,
        botId,
        n.key,
        NOTICE_SOURCE.id,
        "notice",
        n.title,
        n.body ?? null,
        null,
        at,
        "open",
        null,
        null,
      );
      prune.run(botId, NOTICE_SOURCE.id, botId, NOTICE_SOURCE.id, KEPT_EVENTS_PER_SOURCE);
      return { id, duplicate: false };
    },
  );

  return {
    /**
     * Archives a source, which leaves its bot's list until it posts again. Refused while it has an open event;
     * archiving one that is already archived succeeds, so two devices that both ask agree.
     */
    archive(botId: string, sourceId: string): "archived" | "open" | "missing" {
      const s = archiveState.get(botId, sourceId, botId, sourceId);
      if (!s) return "missing";
      if (s.open > 0) return "open";
      archiveSource.run(botId, sourceId);
      return "archived";
    },
    /** The transcript row of a stored event that is not `progress`; `undefined` for an id this bot has no such event under. */
    row(botId: string, id: string): ExternalRow | undefined {
      const r = rowOf.get(botId, id);
      if (!r) return undefined;
      const relay = relayOf(r);
      return {
        type: "external",
        id,
        kind: r.kind,
        source: r.label,
        title: r.title,
        state: r.state,
        ...(relay && { relay }),
      };
    },
    /** An external event that is not `progress` by id alone, in any state; `undefined` when there is none. Ids are unique across bots. */
    item(id: string): EventItem | undefined {
      const r = itemById.get(id);
      return r ? itemOf(r) : undefined;
    },
    /** Every open needs-you item of every bot, in arrival order, oldest first. */
    openItems: (): EventItem[] => openItems.all().map(itemOf),
    /** Whether the bot has this event in state `open`. */
    isOpen: (botId: string, id: string): boolean => openItem.get(botId, id) !== null,
    record,
    recordNotice,
    /** Closes the bot's open notices whose key starts with `keyPrefix` as `resolved`; returns their ids. */
    resolveNotices: (botId: string, keyPrefix: string): string[] =>
      resolveNotices.all(botId, keyPrefix, keyPrefix).map((r) => r.id),
    /**
     * Dismisses one open event. `unchanged` when it is not open any more (another device got there first, or its source
     * resolved it); `unknown` when this bot has no such event or it is a `progress` event.
     */
    dismiss(botId: string, id: string): "closed" | "unchanged" | "unknown" {
      if (dismissOpen.get(botId, id)) return "closed";
      return stored.get(botId, id) ? "unchanged" : "unknown";
    },
    /**
     * Closes one open event as `acted`, because the user answered it, and, when it names a reply target, moves its relay
     * to `pending` with `answer` in the same transaction (`failed` with `failure` instead when there is none to keep).
     * `relay` is whether a relay was started and is now the caller's to run. `unchanged` and `unknown` as `dismiss`.
     */
    answer: db.transaction(
      (
        botId: string,
        id: string,
        plan: { answer: string } | { failure: string },
      ): { outcome: "closed" | "unchanged" | "unknown"; relay: boolean } => {
        const closed = closeAnswered.get(botId, id);
        if (!closed)
          return { outcome: stored.get(botId, id) ? "unchanged" : "unknown", relay: false };
        if (closed.reply === null) return { outcome: "closed", relay: false };
        if ("answer" in plan) startRelay.run(plan.answer, botId, id);
        else failRelay.run(plan.failure, botId, id);
        return { outcome: "closed", relay: "answer" in plan };
      },
    ),
    /** Moves a `failed` relay back to `pending` for another attempt. Otherwise says where it is: `none` is an event with no relay, `unknown` a bot with no such event. */
    retryRelay(botId: string, id: string): "started" | "none" | Relay["state"] | "unknown" {
      if (retryRelay.get(botId, id)) return "started";
      return relayStateOf.get(botId, id)?.relay_state ?? "unknown";
    },
    /** What a `pending` relay needs to run, or `undefined` when the event is not `pending`. */
    relayJob(botId: string, id: string) {
      const j = relayJob.get(botId, id);
      if (!j || j.reply === null) return undefined;
      return {
        reply: JSON.parse(j.reply) as ReplyTarget,
        questionId: j.question_id ?? undefined,
        answer: j.relay_answer,
      };
    },
    /** Ends a `pending` relay as `relayed` or `failed`; false when it was not `pending` (it ended some other way already). */
    finishRelay(botId: string, id: string, outcome: { ok: true } | { error: string }): boolean {
      const state = "ok" in outcome ? "relayed" : "failed";
      return (
        finishRelay.get(state, "ok" in outcome ? null : outcome.error, state, botId, id) !== null
      );
    },
    /** Fails every relay still `pending`, which a host that died mid-call left behind; returns them. */
    failInterrupted: (error: string) => interrupted.all(error),
    /** A bot's event sources that are not archived, most recently heard from first, each with its derived status and recent events. */
    sources(botId: string): WorkSource[] {
      const bySource = new Map<string, SourceEvent[]>();
      for (const r of timeline.all(botId, TIMELINE_EVENTS)) {
        const list = bySource.get(r.source_id) ?? [];
        list.push(toSourceEvent(r));
        bySource.set(r.source_id, list);
      }
      const latest = new Map(latestKinds.all(botId).map((r) => [r.source_id, r.kind]));
      return liveSources.all(botId).map((s) => {
        const events = bySource.get(s.source_id) ?? [];
        return {
          id: s.source_id,
          label: s.label,
          status: statusOf(events, latest.get(s.source_id)),
          lastEventAt: s.last_event_at,
          work: s.work === null ? null : WorkSnapshot.parse(JSON.parse(s.work)),
          events,
        };
      });
    },
    /** What each bot has open: how many events, from which sources (newest first) and when the newest arrived. A bot with none is absent. */
    needsYou: (): Map<string, OpenItems> => {
      const byBot = new Map<string, OpenItems>();
      for (const r of openBySource.all()) {
        const open = byBot.get(r.bot_id) ?? { count: 0, sources: [], newestAt: 0 };
        open.count += r.n;
        open.sources.push(r.label);
        open.newestAt = Math.max(open.newestAt, r.at);
        byBot.set(r.bot_id, open);
      }
      return byBot;
    },
    /** Deletes everything stored for a bot. */
    removeBot(botId: string) {
      db.query("DELETE FROM external_events WHERE bot_id = ?").run(botId);
      db.query("DELETE FROM event_sources WHERE bot_id = ?").run(botId);
    },
  };
}
