import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventAccess } from "@tomte/contract/api";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { eventsOf } from "../testing/watch-events.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "event-rows-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
});
afterEach(async () => {
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

type Streamed = { type: string; [k: string]: unknown };

/** What a page connecting now is sent: the open bot's transcript, as the stream replays it. */
async function pageEvents(): Promise<Streamed[]> {
  const ctl = new AbortController();
  const res = await fetch(`${host.clientUrl}/api/events`, {
    signal: ctl.signal,
    headers: host.authHeaders,
  });
  const reader = res.body!.getReader();
  let text = "";
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), Bun.sleep(100).then(() => undefined)]);
    if (r?.value) text += new TextDecoder().decode(r.value);
  }
  ctl.abort();
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .flatMap((l) => eventsOf(l.slice(6)));
}
const rowsOf = (events: Streamed[]) => events.filter((e) => e.type === "external");
const open = (id: string) => host.ui("/api/open", { id, botId: id });

/** The open bot's stream once the turn of its last event has ended; a turn still running at teardown would outlive the data root. */
async function settled() {
  const ended = (events: Streamed[]) =>
    events.reduce<string | undefined>(
      (last, e) => (e.type === "done" || e.type === "external" ? e.type : last),
      undefined,
    ) === "done";
  let events = await pageEvents();
  while (!ended(events)) events = await pageEvents();
  return events;
}

/** Writes a bot's Claude Code session file as the real CLI would have, so a reopened bot is rebuilt from it. */
function writeSession(botId: string, texts: string[]) {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR!,
    "projects",
    host.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  mkdirSync(dir, { recursive: true });
  const lines = texts.map((text, i) => ({
    uuid: `${botId}-${i}`,
    parentUuid: i ? `${botId}-${i - 1}` : null,
    sessionId: botId,
    timestamp: new Date().toISOString(),
    cwd: host.cwd,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: text },
  }));
  writeFileSync(join(dir, `${botId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function tokenOf(botId: string) {
  const res = await host.ui("/api/bots/events-token", { botId });
  return ((await res.json()) as EventAccess).token;
}

async function post(botId: string, token: string, over: Record<string, unknown>) {
  const res = await fetch(`${host.clientUrl}/api/bots/${botId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      kind: "question",
      key: "k1",
      source: { id: "auth-sso", label: "auth-sso" },
      title: "Which database?",
      ...over,
    }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { id: string }).id;
}

describe("external event rows", () => {
  test("a question shows as one row on the open bot's stream, with no raw wrapped text, and progress shows none", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await open(a);

    const progress = await post(a, token, {
      kind: "progress",
      key: "p1",
      title: "wave 1 running",
      work: { step: "wave 1", items: [{ id: "t1", label: "t1", state: "running" }] },
    });
    const id = await post(a, token, { options: ["DB, encrypted", "DB, plain"] });
    await host.until(() => host.messagesOf(a).length === 1);

    const events = await settled();
    expect(rowsOf(events)).toEqual([
      {
        type: "external",
        id,
        kind: "question",
        source: "auth-sso",
        title: "Which database?",
        state: "open",
      },
    ]);
    expect(rowsOf(events)[0]?.id).not.toBe(progress);
    expect(events.some((e) => e.type === "user")).toBe(false);
    // The work event legitimately carries progress titles; the transcript must not.
    const transcript = JSON.stringify(events.filter((e) => e.type !== "work"));
    expect(transcript).not.toContain("EXTERNAL_EVENT");
    expect(transcript).not.toContain("wave 1 running");
  });

  test("a busy bot shows the row when the event reaches it, after the message that was ahead of it", async () => {
    const a = host.createBot("Planner");
    const token = await tokenOf(a);
    await open(a);
    host.hold();
    await host.ui("/api/send", { text: "first" });
    await host.until(() => host.messagesOf(a).length === 1);

    await post(a, token, { kind: "failed", key: "f1", title: "t04 failed twice" });
    expect(rowsOf(await pageEvents())).toEqual([]);

    host.release();
    await host.until(() => host.messagesOf(a).length === 2);
    const events = await settled();
    expect(rowsOf(events)).toHaveLength(1);
    expect(events.map((e) => e.type).filter((t) => t === "user" || t === "external")).toEqual([
      "user",
      "external",
    ]);
  });

  test("after a restart, a reopened bot rebuilds its rows in order from the session file, and a message queued with an event stays a message", async () => {
    const a = host.createBot("Planner");
    const b = host.createBot("Other");
    const token = await tokenOf(a);
    await open(a);

    const kinds = ["question", "failed", "done"] as const;
    for (const [i, kind] of kinds.entries()) {
      await post(a, token, { kind, key: kind, title: `it is ${kind}` });
      await host.until(() => host.messagesOf(a).length === i + 1);
    }
    const live = rowsOf(await settled());
    expect(live.map((r) => r.kind)).toEqual([...kinds]);

    const received = host.messagesOf(a);
    const [first, second, third] = received as [string, string, string];
    writeSession(a, [first, `typed while busy\n\n${second}\n\n${third}`]);
    await open(b);
    await host.restart();
    await open(a);

    const events = await pageEvents();
    expect(rowsOf(events)).toEqual([live[0]!, live[1]!, live[2]!]);
    expect(
      events
        .filter((e) => e.type === "user" || e.type === "external")
        .map((e) => (e.type === "user" ? e.text : e.kind)),
    ).toEqual(["question", "typed while busy", "failed", "done"]);
    expect(JSON.stringify(events)).not.toContain("EXTERNAL_EVENT");
  });

  test("a wrapped tag naming an event this bot does not have leaves no row and no raw text", async () => {
    const a = host.createBot("Planner");
    const b = host.createBot("Other");
    const token = await tokenOf(a);
    await open(a);
    await post(a, token, { key: "k1" });
    await host.until(() => host.messagesOf(a).length === 1);
    const [text] = host.messagesOf(a) as [string];

    await open(b);
    writeSession(b, [text, "hello"]);
    await host.restart();
    await open(b);

    const events = await pageEvents();
    expect(rowsOf(events)).toEqual([]);
    expect(events.filter((e) => e.type === "user").map((e) => e.text)).toEqual(["hello"]);
    expect(JSON.stringify(events)).not.toContain("EXTERNAL_EVENT");
  });
});
