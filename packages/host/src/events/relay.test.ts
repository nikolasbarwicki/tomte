import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventAccess } from "@claudebot/contract/api";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;
const streams: AbortController[] = [];

const ARGS = ["--session", "{session}", "agent", "prompt", "{agent}", "{message}"];

/** The fake adapter: records its argument list (NUL after each argument, 0x01 after each call) and its inherited secret, then behaves as `mode` says. */
const FAKE_RELAY = `#!/bin/sh
printf '%s\\0' "$@" >> "$RELAY_LOG"
printf '\\001' >> "$RELAY_LOG"
printf '%s' "$CLAUDEBOT_TEST_SECRET" > "$RELAY_LOG.secret"
pwd > "$RELAY_LOG.cwd"
mode=$(cat "$RELAY_LOG.mode" 2>/dev/null || echo 0)
if [ "$mode" = hang ]; then exec sleep 30; fi
if [ "$mode" != 0 ]; then echo "agent offline" >&2; exit "$mode"; fi
exit 0
`;

type Adapter = {
  command?: string;
  args?: string[];
  defaultSession?: string;
  allowAgents?: string[];
  allowSessions?: string[];
  timeoutMs?: number;
};

const paths = () => ({
  script: join(scratch, "fake-relay.sh"),
  config: join(scratch, "relay.json"),
  log: join(scratch, "relay.log"),
});

/** Writes the operator's relay configuration, as private as the host demands. */
function configure(adapters: Record<string, Adapter>, mode = 0o600) {
  const p = paths();
  const full = Object.fromEntries(
    Object.entries(adapters).map(([name, a]) => [
      name,
      { command: p.script, args: ARGS, env: { RELAY_LOG: p.log }, ...a },
    ]),
  );
  writeFileSync(p.config, JSON.stringify({ adapters: full }));
  chmodSync(p.config, mode);
}

const setMode = (mode: string) => writeFileSync(`${paths().log}.mode`, mode);

/** What the adapter was run with, one argument list per call. */
function calls(): string[][] {
  const { log } = paths();
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\u0001")
    .filter((c) => c !== "")
    .map((c) => c.split("\0").slice(0, -1));
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "relay-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  const p = paths();
  writeFileSync(p.script, FAKE_RELAY);
  chmodSync(p.script, 0o755);
  configure({ fake: { allowAgents: ["coord", "coord-b"], timeoutMs: 5000 } });
  host = await startHandoffHost([
    "--data-root",
    join(scratch, "state"),
    "--relay-config",
    p.config,
  ]);
});
afterEach(async () => {
  streams.splice(0).forEach((s) => s.abort());
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

type PageEvent = { type: string; [k: string]: unknown };
type Ask = { id: string; eventId?: string };

interface Page {
  asks(): Ask[];
  count(type: string): number;
  /** The newest state and relay of an external row. */
  row(id: string): { state?: string; relay?: { state: string; attempts: number; error?: string } };
}

/** One page's `/api/events` stream from now on. */
async function watch(): Promise<Page> {
  const stop = new AbortController();
  streams.push(stop);
  const res = await fetch(`${host.clientUrl}/api/events`, {
    signal: stop.signal,
    headers: host.authHeaders,
  });
  const seen: PageEvent[] = [];
  void (async () => {
    const reader = res.body!.getReader();
    let text = "";
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        text += new TextDecoder().decode(r.value);
        const parts = text.split("\n\n");
        text = parts.pop() ?? "";
        for (const p of parts) if (p.startsWith("data: ")) seen.push(JSON.parse(p.slice(6)));
      }
    } catch {
      // The test ended the stream.
    }
  })();
  return {
    asks: () => seen.filter((e) => e.type === "ask") as unknown as Ask[],
    count: (type) => seen.filter((e) => e.type === type).length,
    row(id) {
      const latest = seen
        .filter((e) => (e.type === "external" || e.type === "external_state") && e.id === id)
        .at(-1);
      return (latest ?? {}) as ReturnType<Page["row"]>;
    },
  };
}

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface Posted {
  title?: string;
  source?: string;
  key?: string;
  reply?: unknown;
  questionId?: string | undefined;
  kind?: string;
}

/** Posts an event to a bot's events route with the bot's token; resolves to the response. */
async function postRaw(botId: string, e: Posted) {
  const { token } = await body<EventAccess>(await host.ui("/api/bots/events-token", { botId }));
  return fetch(`${host.clientUrl}/api/bots/${botId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      kind: e.kind ?? "question",
      key: e.key ?? "k1",
      source: { id: e.source ?? "auth-sso", label: e.source ?? "auth-sso" },
      title: e.title ?? "Which database?",
      ...(e.reply !== undefined && { reply: e.reply }),
      ...(e.questionId !== undefined && { questionId: e.questionId }),
    }),
  });
}

async function post(botId: string, e: Posted = {}) {
  const res = await postRaw(botId, e);
  expect(res.status).toBe(202);
  return (await body<{ id: string }>(res)).id;
}

const target = (agent = "coord", session?: string) => ({
  kind: "fake",
  agent,
  ...(session !== undefined && { session }),
});

/** A bot that has received an event with a reply target and finished its turn. */
async function idleBot(e: Posted = {}, name = "Planner") {
  const botId = host.createBot(name);
  await host.ui("/api/open", { botId });
  const page = await watch();
  const id = await post(botId, { reply: target("coord", "s1"), questionId: "Q-7", ...e });
  await host.until(() => host.messagesOf(botId).length >= 1 && page.count("done") >= 1);
  await host.until(() => page.row(id).state === "open");
  return { botId, id, page };
}

/** A bot waiting on an `ask_user` question linked to a posted event. */
async function pendingAsk(e: Posted = {}) {
  const botId = host.createBot("Planner");
  await host.ui("/api/open", { botId });
  const page = await watch();
  host.askOnMessage("Which database?", ["Postgres", "SQLite"], { delivered: true });
  const id = await post(botId, { reply: target("coord", "s1"), questionId: "Q-7", ...e });
  await host.until(() => page.asks().length === 1);
  return { botId, id, page, ask: page.asks()[0]! };
}

const send = (text: string, eventId: string, answer?: string) =>
  host.ui("/api/send", { text, eventId, ...(answer !== undefined && { answer }) });
const retry = (botId: string, id: string) => host.ui("/api/bots/events/relay/retry", { botId, id });

const relayRow = (id: string) => {
  const db = new Database(join(host.dataRoot, "claudebot.db"), { readonly: true });
  try {
    return db
      .query<
        {
          state: string;
          relay_state: string;
          relay_attempts: number;
          relay_answer: string | null;
          relay_error: string | null;
        },
        [string]
      >(
        "SELECT state, relay_state, relay_attempts, relay_answer, relay_error FROM external_events WHERE id = ?",
      )
      .get(id);
  } finally {
    db.close();
  }
};

describe("the answer relay: each way a user answers reaches the sender's agent once", () => {
  test("a Needs-you chip on a pending question relays the option, the target's session and the question id", async () => {
    const { botId, id, page, ask } = await pendingAsk();
    expect(calls()).toEqual([]);

    const res = await send("auth-sso · Which database?: answer 'Postgres'", id, "Postgres");
    expect(await res.json()).toEqual({ ok: true, outcome: "answered" });
    expect(ask.eventId).toBe(id);

    await host.until(() => page.row(id).relay?.state === "relayed");
    expect(calls()).toEqual([["--session", "s1", "agent", "prompt", "coord", "Postgres (Q-7)"]]);
    expect(page.row(id).state).toBe("acted");
    expect(page.row(id).relay?.attempts).toBe(1);
    expect(relayRow(id)?.relay_answer).toBeNull();
    expect(host.messagesOf(botId)).toHaveLength(1);
  });

  test("the transcript's ask card relays what was typed", async () => {
    const { id, page, ask } = await pendingAsk();
    expect((await host.ui("/api/answer", { id: ask.id, value: "SQLite, please" })).status).toBe(
      200,
    );

    await host.until(() => page.row(id).relay?.state === "relayed");
    expect(calls()).toEqual([
      ["--session", "s1", "agent", "prompt", "coord", "SQLite, please (Q-7)"],
    ]);
  });

  test("free text sent to an idle bot relays the text without the draft's prefix", async () => {
    const { id, page } = await idleBot();
    expect((await send("auth-sso · Which database?: use SQLite", id)).status).toBe(200);

    await host.until(() => page.row(id).relay?.state === "relayed");
    expect(calls()).toEqual([["--session", "s1", "agent", "prompt", "coord", "use SQLite (Q-7)"]]);
  });

  test("an answer queued behind a working bot is relayed when it is delivered, not before", async () => {
    const { botId, id, page } = await idleBot();
    host.hold();
    await host.ui("/api/send", { text: "working" });
    await host.until(() => host.messagesOf(botId).length === 2);
    expect((await send("plain answer", id)).status).toBe(200);
    await host.until(() => page.count("queued") === 1);
    expect(calls()).toEqual([]);
    expect(page.row(id).relay).toBeUndefined();

    host.release();
    await host.until(() => page.row(id).relay?.state === "relayed");
    expect(calls()).toEqual([
      ["--session", "s1", "agent", "prompt", "coord", "plain answer (Q-7)"],
    ]);
  });

  test("without a question id the message is the answer alone, and without a session the adapter's default is used", async () => {
    const botId = host.createBot("Planner");
    await host.ui("/api/open", { botId });
    const page = await watch();
    const id = await post(botId, { reply: target("coord") });
    await host.until(() => page.row(id).state === "open" && page.count("done") >= 1);

    await send("yes", id);
    await host.until(() => page.row(id).relay?.state === "relayed");
    expect(calls()).toEqual([["--session", "default", "agent", "prompt", "coord", "yes"]]);
  });

  test("an event without a reply target relays nothing and shows no relay state", async () => {
    const { id, page } = await idleBot({ reply: undefined, questionId: undefined });
    await send("DB", id);
    await host.until(() => page.row(id).state === "acted");
    expect(page.row(id).relay).toBeUndefined();
    expect(calls()).toEqual([]);
  });

  test("a dismissed item relays nothing", async () => {
    const { botId, id, page } = await idleBot();
    await host.ui("/api/bots/events/dismiss", { botId, id });
    await host.until(() => page.row(id).state === "dismissed");
    expect(calls()).toEqual([]);
    expect(page.row(id).relay).toBeUndefined();
  });
});

describe("what an event may name as its reply target", () => {
  test.each([
    ["an agent starting with a dash", { kind: "fake", agent: "--dangerous" }],
    ["an agent with shell syntax in it", { kind: "fake", agent: "$(touch PWNED)" }],
    ["a kind that is not a word", { kind: "Fake Kind", agent: "coord" }],
    ["an unknown field", { kind: "fake", agent: "coord", command: "/bin/sh" }],
    ["a session with a space", { kind: "fake", agent: "coord", session: "a b" }],
    ["a missing agent", { kind: "fake" }],
  ])("%s is refused with 400 naming the field", async (_name, reply) => {
    const botId = host.createBot("Planner");
    const res = await postRaw(botId, { reply });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/reply|agent|kind|session/);
  });

  test("a question id that starts with a dash is refused", async () => {
    const botId = host.createBot("Planner");
    const res = await postRaw(botId, { reply: target(), questionId: "-x" });
    expect(res.status).toBe(400);
  });

  test.each([
    ["an agent the adapter does not allow", target("someone-else"), /not allowed/],
    ["a session the adapter does not allow", target("coord", "other"), /not allowed/],
    ["an adapter kind nobody configured", { kind: "nope", agent: "coord" }, /no relay adapter/],
  ])("%s fails visibly and runs nothing", async (_name, reply, why) => {
    configure({ fake: { allowAgents: ["coord"], allowSessions: ["s1", "default"] } });
    const { id, page } = await idleBot({ reply });
    await send("DB", id);
    await host.until(() => page.row(id).relay?.state === "failed");
    expect(page.row(id).relay?.error).toMatch(why);
    expect(calls()).toEqual([]);
    expect(page.row(id).state).toBe("acted");
  });

  test("with no configuration file the answer closes the item and the relay fails saying so", async () => {
    rmSync(paths().config);
    const { id, page } = await idleBot();
    await send("DB", id);
    await host.until(() => page.row(id).relay?.state === "failed");
    expect(page.row(id).relay?.error).toContain("no relay is configured");
    expect(calls()).toEqual([]);
  });

  test.each([
    ["a file others can write", () => chmodSync(paths().config, 0o666), /writable/],
    ["a file that is not JSON", () => writeFileSync(paths().config, "{not json"), /JSON/],
    [
      "a file with an unknown field",
      () => writeFileSync(paths().config, '{"adapters":{},"x":1}'),
      /x/,
    ],
  ])("%s is refused before anything runs", async (_name, spoil, why) => {
    spoil();
    const { id, page } = await idleBot();
    await send("DB", id);
    await host.until(() => page.row(id).relay?.state === "failed");
    expect(page.row(id).relay?.error).toMatch(why);
    expect(calls()).toEqual([]);
  });
});

describe("what the adapter receives is data, never shell", () => {
  const nasty = [
    "$(touch PWNED); echo `id` && rm -rf /",
    "line one\nline two\twith 'quotes' and \"double\" and \\ backslash",
    "--looks-like-a-flag",
    "ünïcode ✓ 🎉",
  ];

  test.each(nasty)("the answer %j reaches the adapter as one argument, unchanged", async (text) => {
    const { id, page } = await idleBot({ questionId: undefined });
    await send(text, id);
    await host.until(() => page.row(id).relay?.state === "relayed");
    expect(calls()).toEqual([["--session", "s1", "agent", "prompt", "coord", text]]);
    expect(existsSync(join(scratch, "PWNED"))).toBe(false);
    expect(existsSync(join(process.cwd(), "PWNED"))).toBe(false);
  });

  test("the adapter starts in the temporary directory with the host's secrets absent from its environment", async () => {
    process.env.CLAUDEBOT_TEST_SECRET = "must-not-leak";
    try {
      const { id, page } = await idleBot();
      await send("hi", id);
      await host.until(() => page.row(id).relay?.state === "relayed");
      expect(readFileSync(`${paths().log}.secret`, "utf8")).toBe("");
      expect(readFileSync(`${paths().log}.cwd`, "utf8").trim()).toMatch(/\/(tmp|var)\b|\/T\b/);
    } finally {
      delete process.env.CLAUDEBOT_TEST_SECRET;
    }
  });

  test("an answer longer than the limit closes the item and fails the relay without running it", async () => {
    const { id, page } = await idleBot();
    await send("x".repeat(9000), id);
    await host.until(() => page.row(id).relay?.state === "failed");
    expect(page.row(id).relay?.error).toContain("too long");
    expect(calls()).toEqual([]);
    expect(relayRow(id)?.relay_answer).toBeNull();
  });
});

describe("a relay that fails is visible, and retrying it delivers exactly once", () => {
  test("failure, fix, Retry, success; further Retries change nothing", async () => {
    setMode("7");
    const { botId, id, page } = await idleBot();
    await send("DB", id);
    await host.until(() => page.row(id).relay?.state === "failed");
    expect(page.row(id).relay?.error).toBe("fake-relay.sh exited with 7: agent offline");
    expect(page.row(id).state).toBe("acted");
    expect(calls()).toHaveLength(1);

    setMode("0");
    const first = await body<{ started: boolean; state: string }>(await retry(botId, id));
    expect(first).toEqual({ started: true, state: "pending" });
    await host.until(() => page.row(id).relay?.state === "relayed");
    expect(page.row(id).relay?.attempts).toBe(2);
    expect(calls()).toHaveLength(2);
    expect(calls()[1]).toEqual(calls()[0]!);

    const again = await body<{ started: boolean; state: string }>(await retry(botId, id));
    expect(again).toEqual({ started: false, state: "relayed" });
    expect(calls()).toHaveLength(2);
  });

  test("two Retries at once start one relay", async () => {
    setMode("7");
    const { botId, id, page } = await idleBot();
    await send("DB", id);
    await host.until(() => page.row(id).relay?.state === "failed");
    setMode("0");

    const both = await Promise.all([retry(botId, id), retry(botId, id)]);
    const started = (await Promise.all(both.map((r) => body<{ started: boolean }>(r)))).filter(
      (r) => r.started,
    );
    expect(started).toHaveLength(1);
    await host.until(() => page.row(id).relay?.state === "relayed");
    expect(calls()).toHaveLength(2);
  });

  test("a Retry fixes a missing configuration without restarting the host", async () => {
    rmSync(paths().config);
    const { botId, id, page } = await idleBot();
    await send("DB", id);
    await host.until(() => page.row(id).relay?.state === "failed");

    configure({ fake: { allowAgents: ["coord"] } });
    await retry(botId, id);
    await host.until(() => page.row(id).relay?.state === "relayed");
    expect(calls()).toEqual([["--session", "s1", "agent", "prompt", "coord", "DB (Q-7)"]]);
  });

  test("a second answer to a handled item is refused and relays nothing more", async () => {
    const { id, page } = await idleBot();
    expect((await send("first", id)).status).toBe(200);
    await host.until(() => page.row(id).relay?.state === "relayed");
    const again = await send("second", id);
    expect(again.status).toBe(409);
    expect(calls()).toHaveLength(1);
  });

  test("a question answered through its card and then again from Needs you is relayed once", async () => {
    const { id, page, ask } = await pendingAsk();
    const [card, chip] = await Promise.all([
      host.ui("/api/answer", { id: ask.id, value: "Postgres" }),
      send("auth-sso · Which database?: answer 'SQLite'", id, "SQLite"),
    ]);
    expect([card.status, chip.status]).not.toContain(500);
    await host.until(() => page.row(id).relay?.state === "relayed");
    expect(calls()).toHaveLength(1);
  });

  test("a relay that hangs is killed at its timeout and reported as possibly delivered", async () => {
    configure({ fake: { allowAgents: ["coord"], timeoutMs: 300 } });
    setMode("hang");
    const { id, page } = await idleBot();
    await send("DB", id);
    await host.until(() => page.row(id).relay?.state === "pending");
    await host.until(() => page.row(id).relay?.state === "failed", 5000);
    expect(page.row(id).relay?.error).toContain("did not finish within 300 ms");
    expect(page.row(id).relay?.error).toContain("may have been delivered");
  });

  test("a relay still running when the host restarts ends as failed, may-have-been-delivered, and can be retried", async () => {
    setMode("hang");
    const { botId, id } = await idleBot();
    await send("DB", id);
    await host.until(() => calls().length === 1);

    setMode("0");
    await host.restart();
    expect(relayRow(id)).toMatchObject({ state: "acted", relay_state: "failed" });
    expect(relayRow(id)?.relay_answer).toBe("DB");

    expect(relayRow(id)?.relay_error).toContain("may have been delivered");

    expect((await body<{ started: boolean }>(await retry(botId, id))).started).toBe(true);
    await host.until(() => relayRow(id)?.relay_state === "relayed");
    expect(calls()).toHaveLength(2);
    expect(relayRow(id)).toMatchObject({ relay_attempts: 2, relay_answer: null });
  });

  test("a Retry on an item with no relay is a 409, and on an unknown item a 404", async () => {
    const { botId, id } = await idleBot({ reply: undefined, questionId: undefined });
    await send("DB", id);
    await host.until(() => relayRow(id)?.state === "acted");
    expect((await retry(botId, id)).status).toBe(409);
    expect((await retry(botId, "no-such-event")).status).toBe(404);
    expect((await retry("no-such-bot", id)).status).toBe(404);
  });
});

describe("several items, sources and agents", () => {
  test("each answer goes to its own event's agent and question, and no other", async () => {
    const botId = host.createBot("Planner");
    await host.ui("/api/open", { botId });
    const page = await watch();
    const a = await post(botId, {
      key: "a",
      source: "alpha",
      title: "A?",
      reply: target("coord", "s1"),
      questionId: "QA",
    });
    const b = await post(botId, {
      key: "b",
      source: "beta",
      title: "B?",
      reply: target("coord-b", "s2"),
      questionId: "QB",
    });
    await host.until(() => page.row(a).state === "open" && page.row(b).state === "open");
    await host.until(() => page.count("done") >= 1);

    await send("beta · B?: two", b);
    await host.until(() => page.row(b).relay?.state === "relayed");
    expect(page.row(a).relay).toBeUndefined();
    await host.until(() => page.count("done") >= 2);
    await send("alpha · A?: one", a);
    await host.until(() => page.row(a).relay?.state === "relayed");

    expect(calls()).toEqual([
      ["--session", "s2", "agent", "prompt", "coord-b", "two (QB)"],
      ["--session", "s1", "agent", "prompt", "coord", "one (QA)"],
    ]);
  });

  test("a failure on one item leaves the other's relay alone", async () => {
    configure({ fake: { allowAgents: ["coord"] } });
    const botId = host.createBot("Planner");
    await host.ui("/api/open", { botId });
    const page = await watch();
    const bad = await post(botId, { key: "a", source: "alpha", reply: target("stranger") });
    const good = await post(botId, { key: "b", source: "beta", reply: target("coord", "s1") });
    await host.until(() => page.row(good).state === "open" && page.row(bad).state === "open");
    await host.until(() => page.count("done") >= 1);

    await send("alpha · Which database?: x", bad);
    await host.until(() => page.row(bad).relay?.state === "failed");
    await host.until(() => page.count("done") >= 2);
    await send("beta · Which database?: y", good);
    await host.until(() => page.row(good).relay?.state === "relayed");
    expect(page.row(bad).relay?.state).toBe("failed");
    expect(calls()).toEqual([["--session", "s1", "agent", "prompt", "coord", "y"]]);
  });
});

describe("the reply target is data for the host, not for the bot", () => {
  test("the text the bot receives does not carry the adapter, agent or session", async () => {
    const { botId } = await idleBot({ reply: target("coord-secret-name", "private-session") });
    const seen = host.messagesOf(botId).join("\n");
    expect(seen).not.toContain("coord-secret-name");
    expect(seen).not.toContain("private-session");
    expect(seen).not.toContain("fake");
  });
});

describe("the sender and the relay together", () => {
  test("a question sent with --reply is answered from Needs you and relayed with its session and question id", async () => {
    const botId = host.createBot("Planner");
    const route = await body<EventAccess>(await host.ui("/api/bots/events-token", { botId }));
    await host.ui("/api/open", { botId });
    const page = await watch();

    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../../notify/src/main.ts"),
        "--reply",
        "fake:coord",
        "--reply-session",
        "s1",
        "question",
        "04-notify",
        "omp-7",
        "Which database?",
        "Q-3",
      ],
      {
        cwd: scratch,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: scratch,
          CLAUDEBOT_EVENTS_URL: route.url,
          CLAUDEBOT_EVENTS_TOKEN: route.token,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);

    await host.until(() => host.messagesOf(botId).length === 1);
    const id = /id=(\S+) kind=question/.exec(host.messagesOf(botId)[0]!)![1]!;
    await host.until(() => page.row(id).state === "open" && page.count("done") >= 1);
    expect((await send("04-notify · Which database?: Postgres", id)).status).toBe(200);

    await host.until(() => page.row(id).relay?.state === "relayed");
    expect(calls()).toEqual([["--session", "s1", "agent", "prompt", "coord", "Postgres (Q-3)"]]);
  });
});
