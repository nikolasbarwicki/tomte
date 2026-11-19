import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { frontContext, getBot } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { ProgressAttribution, createLoopServer } from "./agents.ts";
import { FrontSession } from "./front.ts";
import { Observer } from "./observe.ts";
import { createLoopStore, type SessionLog } from "./store.ts";
import { Tasks } from "./tasks.ts";

let host: HandoffHost;
let scratch: string;
let bot: string;
let log: SessionLog;
let lines: string[];
let results: number;
let session: FrontSession | undefined;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "front-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
  host = await startHandoffHost();
  bot = host.createBot("Dev");
  lines = [];
  results = 0;
  session = undefined;
});
afterEach(async () => {
  session?.close("test over");
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

/** A front session for the bot over the fake Claude CLI, with its own task log. */
function openFront({
  expiresAt,
  ...extra
}: {
  idleMs?: number;
  expiresAt?: () => Promise<number | undefined>;
  now?: () => number;
} = {}) {
  const botRow = defined(getBot(host.dataRoot, bot), "bot");
  const context = frontContext(host.dataRoot, botRow);
  const { persona, workerPersona, files, memory } = context;
  const sessionId = defined(context.sessionId, "session id");
  log = createLoopStore(host.db).session(bot, sessionId);
  const attribution = new ProgressAttribution();
  const tasks = new Tasks({ log, maxParallel: 3, dispatch: () => {}, emit: () => {} });
  const observer = new Observer({
    log,
    tasks,
    attribution,
    emit: () => {},
    changed: () => {},
    defaults: () => ({ model: "sonnet", effort: "medium" }),
    logLine: () => {},
  });
  session = new FrontSession({
    cli: { path: host.cliPath, source: "CLAUDE_PATH", needsShell: false },
    claude: {
      env: () => ({}),
      signInState: () => "unknown",
      checkSignIn: async () => "unknown",
      requireSignIn: async () => {},
      usage: async () => ({ available: false, windows: [], checkedAt: 0 }),
      report: () => ({ state: "unknown", account: null, cliVersion: null }),
      gateway: () => undefined,
      setGateway: () => {},
      login: {
        start: async () => ({ url: "" }),
        submit: async () => {},
        cancel: () => {},
        pending: () => undefined,
      },
      close: () => {},
    },
    cwd: host.cwd,
    sessionId,
    resume: false,
    hostServers: () => ({ servers: [], release: () => {} }),
    delegate: { askUser: async () => "", approve: async () => ({ behavior: "allow" }) },
    log: (l) => lines.push(l),
    persona,
    workerPersona,
    files,
    memory,
    integrations: {
      session: async () => ({
        mcpServers: {},
        builtinServers: {},
        disallowedTools: [],
        plugins: [],
        policyOf: () => undefined,
        expiresAt: await expiresAt?.(),
      }),
      decide: () => undefined,
      prepareApproval: async (_name, input) => ({ input }),
      locked: () => false,
      reconcile: () => {},
    },
    observer,
    tasks,
    loopServer: createLoopServer({
      attribution,
      onProgress: () => {},
      queue: () => ({ ok: false, error: "no queue here" }),
      cancelQueued: () => ({ ok: false, error: "no queue here" }),
    }),
    onMessage: (m: SDKMessage) => {
      if (m.type === "result") results++;
      observer.onMessage(m);
    },
    onEnd: () => {},
    onStopped: () => observer.interruptRunning(),
    agentSettings: { model: "sonnet", effort: "medium" },
    ...extra,
  });
  return session;
}

const agent = (taskId: string, status: "running" | "interrupted" = "running") =>
  log.putTask({ taskId, goal: `goal ${taskId}`, status, startedAt: 1 }, 1);
const closes = () => lines.filter((l) => l.startsWith("[host] front closed"));
const notices = () =>
  host.messageRecords(bot).filter((m) => m.text.startsWith("The app restarted"));

/** Sends a message and waits for the fake CLI's answer to it. */
async function say(front: FrontSession, text: string) {
  const before = results;
  await front.send(text);
  await host.until(() => results > before);
}

describe("closes that wait for the agents", () => {
  test("the idle timer does not close a front while an agent runs, and does once none does", async () => {
    const front = openFront({ idleMs: 40 });
    agent("a");
    await say(front, "hello");
    // The idle timer is a real timer firing against the platform clock (40 ms here); only a wait past several firings shows it left the front open.
    await Bun.sleep(200);
    expect(closes()).toEqual([]);
    expect(host.launches()).toHaveLength(1);

    log.setStatus("a", "done", 2);
    await host.until(() => closes().length === 1);
    expect(closes()[0]).toContain("(idle)");

    await say(front, "back again");
    expect(host.launches()).toHaveLength(2);
    expect(
      defined(host.launches()[1], "second launch").argv.some((a) => a.startsWith("--resume")),
    ).toBe(true);
  });

  test("closeWhenIdle closes an idle front at once and a busy one after its agent ends", async () => {
    const front = openFront();
    await say(front, "hello");
    front.closeWhenIdle("settings changed");
    expect(closes()).toHaveLength(1);
    expect(closes()[0]).toContain("(settings changed)");

    await say(front, "hello again");
    agent("a");
    front.closeWhenIdle("integrations changed");
    front.settle();
    expect(closes()).toHaveLength(1);
    // A second request while one waits does not replace its reason, and a message sent meanwhile goes to the same process.
    front.closeWhenIdle("bots changed");
    await say(front, "still there?");
    expect(host.launches()).toHaveLength(2);

    log.setStatus("a", "done", 2);
    front.settle();
    expect(closes()).toHaveLength(2);
    expect(closes()[1]).toContain("(integrations changed)");

    await say(front, "after the change");
    expect(host.launches()).toHaveLength(3);
  });

  test("a request to close a front that is not open does nothing", () => {
    const front = openFront();
    front.closeWhenIdle("settings changed");
    front.settle();
    expect(closes()).toEqual([]);
  });

  test("a queue entry the front was asked to start keeps it open", async () => {
    const front = openFront();
    await say(front, "hello");
    const queued = front.tasks.queue("compare plans", "researcher", null);
    expect(queued.ok).toBe(true);
    expect(front.idle()).toBe(false);

    front.closeWhenIdle("settings changed");
    expect(closes()).toEqual([]);
    if (queued.ok) front.tasks.cancelQueued(queued.id);
    front.settle();
    expect(closes()).toHaveLength(1);
  });

  test("an expired integration token closes an idle front on the next message and a busy one when its agent ends", async () => {
    let clock = 0;
    let reads = 0;
    const front = openFront({
      now: () => clock,
      expiresAt: async () => {
        reads++;
        return clock + 1000;
      },
    });
    await say(front, "hello");
    expect(reads).toBe(1);

    // Idle: the message reopens the session first.
    clock = 1500;
    await say(front, "idle and expired");
    expect(closes()).toHaveLength(1);
    expect(closes()[0]).toContain("(integration token expiring)");
    expect(host.launches()).toHaveLength(2);
    expect(reads).toBe(2);

    // An agent runs: the message goes to the open session, which closes once the agent ends.
    agent("a");
    clock = 3000;
    await say(front, "busy and expired");
    expect(closes()).toHaveLength(1);
    expect(host.launches()).toHaveLength(2);
    front.settle();
    expect(closes()).toHaveLength(1);

    log.setStatus("a", "done", 2);
    front.settle();
    expect(closes()).toHaveLength(2);
    await say(front, "fresh token");
    expect(host.launches()).toHaveLength(3);
    expect(reads).toBe(3);
  });

  test("a front that never expires or has no token is left alone", async () => {
    const front = openFront({
      expiresAt: async () => undefined,
      now: () => Number.MAX_SAFE_INTEGER,
    });
    await say(front, "hello");
    front.settle();
    await say(front, "again");
    expect(closes()).toEqual([]);
    expect(host.launches()).toHaveLength(1);
  });
});

describe("recovery after a restart", () => {
  test("a fresh front is told once, in a synthetic message that lists every interrupted task", async () => {
    const front = openFront();
    agent("a", "interrupted");
    agent("b", "interrupted");
    log.putTask({ taskId: "c", goal: "goal c", status: "done", startedAt: 1 }, 1);
    expect(front.needsRecovery()).toBe(true);

    const before = results;
    expect(await front.recover()).toBe(true);
    await host.until(() => results > before);
    expect(front.needsRecovery()).toBe(false);
    expect(await front.recover()).toBe(false);
    await say(front, "hello");

    const records = host.messageRecords(bot);
    expect(notices()).toHaveLength(1);
    expect(records[0]).toMatchObject({ isSynthetic: true, priority: "next" });
    expect(records[0]?.text).toContain(
      "The app restarted. These agents were interrupted:\n- id a: goal a\n- id b: goal b\nResume each with SendMessage",
    );
    expect(records[0]?.text.split("<work_state>")[0]).not.toContain("id c");
    expect(records[1]?.text).toStartWith("hello");
  });

  test("a message that opens the front comes after the notice", async () => {
    const front = openFront();
    agent("a", "interrupted");
    await say(front, "hello");
    await host.until(() => host.messageRecords(bot).length === 2);

    expect(host.messageRecords(bot).map((m) => m.text.split("\n")[0])).toEqual([
      "The app restarted. These agents were interrupted:",
      "hello",
    ]);
  });

  test("nothing is sent when no task is interrupted, and a new CLI process is told again about tasks still interrupted", async () => {
    const front = openFront();
    expect(front.needsRecovery()).toBe(false);
    expect(await front.recover()).toBe(false);
    await say(front, "hello");
    expect(notices()).toEqual([]);

    agent("a", "interrupted");
    // The same process was already open before the task was cut off, so the next process is the one that hears of it.
    front.close("test");
    await say(front, "second process");
    expect(notices()).toHaveLength(1);
    front.close("test");
    await say(front, "third process");
    expect(notices()).toHaveLength(2);
  });

  test("a CLI process that dies leaves its running agents interrupted and the next one is told", async () => {
    const front = openFront();
    host.loopScript({ match: "crash now", steps: [{ exit: 1 }] });
    agent("a");
    await front.send("crash now");
    await host.until(() => lines.some((l) => l.startsWith("[host] front ended")));
    expect(log.getTask("a")?.status).toBe("interrupted");
    await say(front, "after the crash");
    expect(notices()).toHaveLength(1);
  });
});
