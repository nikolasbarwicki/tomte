import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import type { ExternalEventInput } from "@claudebot/contract/api";

import { migrate } from "../platform/db.ts";
import { createEventStore } from "./store.ts";

let db: Database;
let store: ReturnType<typeof createEventStore>;

beforeEach(() => {
  db = migrate(new Database(":memory:"));
  store = createEventStore(db);
});

/** An event with no reply target. */
const bareEvent = (key: string, over: Partial<ExternalEventInput> = {}): ExternalEventInput => ({
  kind: "question",
  key,
  source: { id: "s", label: "S" },
  title: "Which?",
  ...over,
});

const event = (over: Partial<ExternalEventInput> = {}): ExternalEventInput =>
  bareEvent("k1", {
    reply: { kind: "herdr", agent: "coord", session: "s1" },
    questionId: "Q-1",
    ...over,
  });

const record = (over?: Partial<ExternalEventInput>) => store.record("bot", event(over), 1).id;
const recordBare = (key: string, over?: Partial<ExternalEventInput>) =>
  store.record("bot", bareEvent(key, over), 1).id;
const relayOf = (id: string) => store.row("bot", id)?.relay;

describe("answering an item that names a reply target", () => {
  test("closes it as acted and makes the relay pending with the answer kept, once", () => {
    const id = record();
    expect(relayOf(id)).toBeUndefined();

    expect(store.answer("bot", id, { answer: "Postgres" })).toEqual({
      outcome: "closed",
      relay: true,
    });
    expect(store.row("bot", id)).toMatchObject({
      state: "acted",
      relay: { state: "pending", attempts: 1 },
    });
    expect(store.relayJob("bot", id)).toEqual({
      reply: { kind: "herdr", agent: "coord", session: "s1" },
      questionId: "Q-1",
      answer: "Postgres",
    });

    expect(store.answer("bot", id, { answer: "SQLite" })).toEqual({
      outcome: "unchanged",
      relay: false,
    });
    expect(store.relayJob("bot", id)?.answer).toBe("Postgres");
  });

  test("an event without a target is only closed", () => {
    const bare = recordBare("bare");
    expect(store.answer("bot", bare, { answer: "x" })).toEqual({ outcome: "closed", relay: false });
    expect(relayOf(bare)).toBeUndefined();
    expect(store.relayJob("bot", bare)).toBeUndefined();
    expect(store.isOpen("bot", bare)).toBe(false);
  });

  test("a failure plan stores a failed relay with its reason and nothing to run", () => {
    const id = record();
    expect(store.answer("bot", id, { failure: "too long" })).toEqual({
      outcome: "closed",
      relay: false,
    });
    expect(relayOf(id)).toEqual({ state: "failed", attempts: 1, error: "too long" });
    expect(store.relayJob("bot", id)).toBeUndefined();
  });

  test("a dismissed or resolved item cannot be answered afterwards, and an unknown one says so", () => {
    const id = record();
    expect(store.dismiss("bot", id)).toBe("closed");
    expect(store.answer("bot", id, { answer: "late" })).toEqual({
      outcome: "unchanged",
      relay: false,
    });
    expect(relayOf(id)).toBeUndefined();
    expect(store.answer("bot", "nope", { answer: "x" })).toEqual({
      outcome: "unknown",
      relay: false,
    });
    expect(store.answer("other-bot", id, { answer: "x" }).outcome).toBe("unknown");
  });
});

describe("a relay's life", () => {
  test("pending ends as relayed, drops the stored answer and cannot end twice", () => {
    const id = record();
    store.answer("bot", id, { answer: "Postgres" });
    expect(store.finishRelay("bot", id, { ok: true })).toBe(true);
    expect(relayOf(id)).toEqual({ state: "relayed", attempts: 1 });
    expect(db.query("SELECT relay_answer FROM external_events WHERE id = ?").get(id)).toEqual({
      relay_answer: null,
    });
    expect(store.finishRelay("bot", id, { error: "late" })).toBe(false);
    expect(store.retryRelay("bot", id)).toBe("relayed");
  });

  test("failed keeps the answer, and a retry starts exactly one more attempt", () => {
    const id = record();
    store.answer("bot", id, { answer: "Postgres" });
    store.finishRelay("bot", id, { error: "exit 7" });
    expect(relayOf(id)).toEqual({ state: "failed", attempts: 1, error: "exit 7" });

    expect(store.retryRelay("bot", id)).toBe("started");
    expect(store.retryRelay("bot", id)).toBe("pending");
    expect(relayOf(id)).toEqual({ state: "pending", attempts: 2 });
    expect(store.relayJob("bot", id)?.answer).toBe("Postgres");
  });

  test("a retry says none for an event without a relay or a progress event, and unknown for a stranger", () => {
    const bare = recordBare("b");
    const info = record({ kind: "progress", key: "p" });
    expect(store.retryRelay("bot", bare)).toBe("none");
    expect(store.retryRelay("bot", info)).toBe("unknown");
    expect(store.retryRelay("bot", "nope")).toBe("unknown");
    expect(store.retryRelay("other", bare)).toBe("unknown");
  });

  test("a relay left pending by a dead host is failed, once, with the reason", () => {
    const a = record({ key: "a" });
    const b = record({ key: "b" });
    store.answer("bot", a, { answer: "x" });
    store.answer("bot", b, { answer: "y" });
    store.finishRelay("bot", b, { ok: true });

    expect(store.failInterrupted("cut off")).toEqual([{ bot_id: "bot", id: a }]);
    expect(relayOf(a)).toEqual({ state: "failed", attempts: 1, error: "cut off" });
    expect(relayOf(b)?.state).toBe("relayed");
    expect(store.failInterrupted("again")).toEqual([]);
  });

  test("the relay shows in the Work timeline", () => {
    const id = record();
    store.answer("bot", id, { answer: "x" });
    const [source] = store.sources("bot");
    expect(source?.events.find((e) => e.id === id)?.relay).toEqual({
      state: "pending",
      attempts: 1,
    });
  });
});

describe("the relay columns", () => {
  test("a database made before them keeps its events, with no relay", () => {
    const old = new Database(":memory:");
    migrate(old);
    const before = createEventStore(old);
    const id = before.record("bot", bareEvent("k1"), 1).id;
    old.run("ALTER TABLE external_events DROP COLUMN relay_answer");
    old.run("ALTER TABLE external_events DROP COLUMN relay_error");
    old.run("ALTER TABLE external_events DROP COLUMN relay_attempts");
    old.run("ALTER TABLE external_events DROP COLUMN relay_state");
    old.run("ALTER TABLE external_events DROP COLUMN reply");
    old.run("ALTER TABLE external_events DROP COLUMN question_id");
    old.run("PRAGMA user_version = 12");

    migrate(old);

    const after = createEventStore(old);
    expect(after.row("bot", id)).toMatchObject({ id, state: "open" });
    expect(after.row("bot", id)?.relay).toBeUndefined();
    expect(old.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: 14,
    });
  });
});
