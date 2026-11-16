import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventAccess } from "@claudebot/contract/api";

import { migrate } from "../platform/db.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents } from "../testing/watch-events.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "blocked-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
});
afterEach(async () => {
  streams.splice(0).forEach((s) => s.stop());
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

const streams: { stop(): void }[] = [];

/** One page's `/api/events` stream from now on, ended with the test. */
async function watch() {
  const page = await watchEvents(host);
  streams.push(page);
  return page;
}

async function tokenOf(botId: string) {
  const res = await host.ui("/api/bots/events-token", { botId });
  return ((await res.json()) as EventAccess).token;
}

const postRaw = (botId: string, token: string, over: Record<string, unknown>) =>
  fetch(`${host.clientUrl}/api/bots/${botId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      kind: "blocked",
      key: "k1",
      source: { id: "wave-runner", label: "Wave runner" },
      title: "t04 is waiting for the API key",
      ...over,
    }),
  });

async function post(botId: string, token: string, over: Record<string, unknown> = {}) {
  const res = await postRaw(botId, token, over);
  expect(res.status).toBe(202);
  return ((await res.json()) as { id: string }).id;
}

describe("a blocked report", () => {
  test("wakes the bot, shows as its own kind, needs the user until answered and replays to a later page", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await host.ui("/api/open", { botId: a });
    const page = await watch();

    const id = await post(a, token, { body: "Need the staging key.\nSecond line." });
    await host.until(() => host.messagesOf(a).length === 1);
    const [text] = host.messagesOf(a) as [string];
    expect(text).toContain(`id=${id} kind=blocked `);
    expect(text).toContain("t04 is waiting for the API key");
    expect(text).toContain("Need the staging key.\nSecond line.");

    await host.until(() => page.stateOf(id) === "open");
    expect(page.rowOf(id)).toMatchObject({ kind: "blocked", source: "Wave runner" });
    await host.until(() => page.needsYou(a) === 1);
    await host.until(() => page.status(a)["wave-runner"] === "blocked");

    const later = await watch();
    await host.until(() => later.rowOf(id) !== undefined);
    expect(later.rowOf(id)).toMatchObject({ kind: "blocked", state: "open" });

    const answered = await host.ui("/api/send", { text: "key is in 1Password", eventId: id });
    expect(answered.status).toBe(200);
    await host.until(() => page.stateOf(id) === "acted");
    await host.until(() => page.needsYou(a) === 0);
    expect(page.status(a)["wave-runner"]).toBe("running");
  });

  test("ranks between a question and a failure, and each leaves the source when closed", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await host.ui("/api/open", { botId: a });
    const page = await watch();
    const failed = await post(a, token, { kind: "failed", key: "f1", title: "t03 failed" });
    await host.until(() => page.status(a)["wave-runner"] === "failed");
    const blocked = await post(a, token, { key: "b1" });
    await host.until(() => page.status(a)["wave-runner"] === "blocked");
    const asked = await post(a, token, { kind: "question", key: "q1", title: "Which key?" });
    await host.until(() => page.status(a)["wave-runner"] === "needs_you");
    await host.until(() => page.needsYou(a) === 3);

    const dismiss = (id: string) => host.ui("/api/bots/events/dismiss", { botId: a, id });
    expect((await dismiss(asked)).status).toBe(200);
    await host.until(() => page.status(a)["wave-runner"] === "blocked");
    expect((await dismiss(blocked)).status).toBe(200);
    await host.until(() => page.status(a)["wave-runner"] === "failed");
    expect((await dismiss(failed)).status).toBe(200);
    await host.until(() => page.needsYou(a) === 0);
    expect(page.status(a)["wave-runner"]).toBe("running");
  });

  test("is resolved by a later report of its source that names it, and a retry is a duplicate", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await host.ui("/api/open", { botId: a });
    const page = await watch();
    const id = await post(a, token, { key: "b1" });
    await host.until(() => page.needsYou(a) === 1);

    const again = await postRaw(a, token, { key: "b1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, duplicate: true });

    await post(a, token, { kind: "progress", key: "p1", title: "unblocked", resolves: ["b1"] });
    await host.until(() => page.stateOf(id) === "resolved");
    await host.until(() => page.needsYou(a) === 0);
  });

  test("carries no suggested answers", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    const res = await postRaw(a, token, { options: ["Yes"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "options: only a question carries options" });
  });
});

describe("the external events table", () => {
  test("a database made before `blocked` keeps its events, their order and its indexes, and takes blocked ones", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE external_events (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, key TEXT NOT NULL, source_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('question','failed','done','stopped','progress')),
      title TEXT NOT NULL, body TEXT, options TEXT, received_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open','acted','dismissed','resolved','info')),
      UNIQUE (bot_id, key))`);
    const insert = db.query(
      "INSERT INTO external_events (id, bot_id, key, source_id, kind, title, body, options, received_at, state) VALUES (?, 'a', ?, 's', ?, ?, ?, ?, 1, ?)",
    );
    insert.run("e1", "k1", "question", "first", "body", '["Yes"]', "open");
    insert.run("e2", "k2", "progress", "second", null, null, "info");
    db.run("PRAGMA user_version = 11");
    expect(() => insert.run("e3", "k3", "blocked", "third", null, null, "open")).toThrow();

    migrate(db);

    insert.run("e3", "k3", "blocked", "third", null, null, "open");
    expect(
      db.query("SELECT id, kind, body, options FROM external_events ORDER BY rowid").all(),
    ).toEqual([
      { id: "e1", kind: "question", body: "body", options: '["Yes"]' },
      { id: "e2", kind: "progress", body: null, options: null },
      { id: "e3", kind: "blocked", body: null, options: null },
    ]);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'external_events_%'",
        )
        .all()
        .map((r) => (r as { name: string }).name)
        .sort(),
    ).toEqual(["external_events_by_source", "external_events_open"]);
  });
});
