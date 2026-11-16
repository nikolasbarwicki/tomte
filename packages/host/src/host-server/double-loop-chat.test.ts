import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { botMemoryPath, getBot, readMemory, setChatMode } from "../bots/index.ts";
import { defined } from "../testing/defined.ts";
import { writeSession } from "../testing/session-file.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "double-loop-"));
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

/** What a page connecting now is sent: the open bot's transcript, its presence and the sidebar. */
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
    .map((l) => JSON.parse(l.slice(6)));
}

const presenceOf = (events: Streamed[]) => events.find((e) => e.type === "presence")?.state;
const statusOf = (events: Streamed[], botId: string) =>
  (
    events.find((e) => e.type === "bots") as { bots: { id: string; status: string }[] } | undefined
  )?.bots.find((b) => b.id === botId)?.status;

/** A bot that is already in double-loop mode on its first session, which is the session id the fake CLI reports for it. */
async function doubleLoopBot(name = "Dev") {
  const id = host.createBot(name);
  setChatMode(host.dataRoot, id, "double_loop");
  expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
  return id;
}

const send = async (text: string) => {
  const res = await host.ui("/api/send", { text });
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; outcome: string };
};

/** The bot's page-visible state once its front is idle again. */
async function settled(botId: string) {
  let events = await pageEvents();
  for (let i = 0; i < 20 && presenceOf(events) !== "idle"; i++) events = await pageEvents();
  expect(presenceOf(events)).toBe("idle");
  expect(statusOf(events, botId)).not.toBe("working");
  return events;
}

describe("a double-loop bot's front session", () => {
  test("two messages a second apart are both sent, never queued, and share one CLI process", async () => {
    const bot = await doubleLoopBot();
    host.hold();

    expect(await send("first")).toEqual({ ok: true, outcome: "sent" });
    await host.until(() => host.messagesOf(bot).length === 1);
    // The spec's scenario: the second message comes a real second after the first, with the first turn still running.
    await Bun.sleep(1000);

    // The first turn is still running: a standard bot would queue this one.
    const busy = await pageEvents();
    expect(presenceOf(busy)).toBe("typing");
    expect(statusOf(busy, bot)).toBe("working");
    expect(await send("second")).toEqual({ ok: true, outcome: "sent" });
    await host.until(() => host.messagesOf(bot).length === 2);

    host.release();
    const events = await settled(bot);
    expect(events.some((e) => e.type === "queued")).toBe(false);
    expect(events.filter((e) => e.type === "user").map((e) => e.text)).toEqual(["first", "second"]);

    expect(host.launches()).toHaveLength(1);
    const [first, second] = host.messagesOf(bot);
    expect(first).toStartWith("first\n\n<work_state>\nrunning (0 of 3 slots): (none)\n");
    expect(first).toEndWith("</work_state>");
    expect(second).toStartWith("second\n\n<work_state>\n");
    // The CLI takes a message mid-turn only with priority `next`, and treats one with a human origin as typed by the user.
    expect(host.messageRecords(bot)).toMatchObject([
      { priority: "next", origin: { kind: "human" } },
      { priority: "next", origin: { kind: "human" } },
    ]);
  });

  test("a message is sent to the front's session, which opens on haiku with the front's tools and the interrupted-turn flag", async () => {
    const bot = await doubleLoopBot();
    await send("hello");
    await host.until(() => host.messagesOf(bot).length === 1);

    const launch = defined(host.launches()[0], "launch");
    expect(launch.argv).toContain("--model=claude-haiku-5-5");
    expect(launch.argv).toContain("--thinking=disabled");
    expect(launch.argv).toContain(
      "--tools=Agent,SendMessage,TaskStop,WebSearch,WebFetch,Read,Write,Edit,NotebookEdit,Glob,Grep,Bash",
    );
    expect(launch.argv).toContain(`--session-id=${bot}`);
    expect(launch.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("1");
    expect(launch.appendSystemPrompt).toContain("You are the chat voice of an assistant");
    // The front only hands off: no browser server.
    expect(Object.keys(launch.mcpServers)).toEqual(["bots"]);
    await settled(bot);
  });

  test("the front keeps memory through its host server", async () => {
    const bot = await doubleLoopBot();
    host.rememberOnMessage("bot", "Always answer in one line.");
    await send("keep this in mind");
    await host.until(() => readMemory(botMemoryPath(host.dataRoot, bot)).includes("one line"));
    await settled(bot);
  });

  test("a rate limit the CLI reports reaches the page and is sent again to a page that connects later, for each window, and a standard bot's page is sent none", async () => {
    const bot = await doubleLoopBot();
    host.loopScript({
      steps: [
        {
          emit: {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed_warning",
              rateLimitType: "five_hour",
              utilization: 0.7,
              resetsAt: 1_800_000_000,
            },
          },
        },
        {
          emit: {
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 0.2 },
          },
        },
        {
          emit: {
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 1 },
          },
        },
      ],
    });
    await send("hello");
    await host.until(() => host.messagesOf(bot).length === 1);
    await settled(bot);

    // A page connecting now gets the latest report of each window, after the presence, and none of it is in the transcript history.
    const limits = (await pageEvents()).filter((e) => e.type === "rate_limit");
    expect(limits).toEqual([
      { type: "rate_limit", status: "rejected", window: "five_hour", utilization: 1 },
      { type: "rate_limit", status: "allowed", window: "seven_day", utilization: 0.2 },
    ]);

    const other = host.createBot("Plain");
    expect((await host.ui("/api/open", { id: other, botId: other })).status).toBe(200);
    expect((await pageEvents()).some((e) => e.type === "rate_limit")).toBe(false);
  });

  test("an external event is delivered to the front as it comes, while a user message is still running", async () => {
    const bot = await doubleLoopBot();
    host.hold();
    await send("go");
    await host.until(() => host.messagesOf(bot).length === 1);

    const token = (
      (await (await host.ui("/api/bots/events-token", { botId: bot })).json()) as { token: string }
    ).token;
    const posted = await fetch(`${host.clientUrl}/api/bots/${bot}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: "question",
        key: "k1",
        source: { id: "ci", label: "ci" },
        title: "Which database?",
      }),
    });
    expect(posted.status).toBe(202);
    await host.until(() => host.messagesOf(bot).length === 2);
    expect(host.messagesOf(bot)[1]).toContain("<<<EXTERNAL_EVENT");
    expect(host.messagesOf(bot)[1]).toContain("</work_state>");
    const [typed, app] = host.messageRecords(bot);
    expect(typed).toMatchObject({ priority: "next", origin: { kind: "human" } });
    expect(app).toMatchObject({ priority: "next", isSynthetic: true });
    expect(app).not.toHaveProperty("origin");

    host.release();
    const events = await settled(bot);
    expect(events.some((e) => e.type === "queued")).toBe(false);
    expect(events.filter((e) => e.type === "external")).toHaveLength(1);
    expect(host.launches()).toHaveLength(1);
  });

  test("starting a new session closes the front, and the next message opens a fresh one", async () => {
    const bot = await doubleLoopBot();
    await send("one");
    await host.until(() => host.messagesOf(bot).length === 1);
    await settled(bot);

    expect((await host.ui("/api/session/new", {})).status).toBe(200);
    await send("two");
    await host.until(() => host.launches().length === 2);
    const fresh = defined(getBot(host.dataRoot, bot)?.sessions.at(-1), "new session");
    expect(fresh).not.toBe(bot);
    expect(host.launches()[1]?.argv).toContain(`--session-id=${fresh}`);
    await settled(bot);
  });

  test("a new session is refused while the front is answering", async () => {
    const bot = await doubleLoopBot();
    host.hold();
    await send("go");
    await host.until(() => host.messagesOf(bot).length === 1);
    expect((await host.ui("/api/session/new", {})).status).toBe(409);
    host.release();
    await settled(bot);
  });

  test("a CLI that dies is reported, and the next message resumes the session", async () => {
    const bot = await doubleLoopBot();
    host.askOnMessage("anything?", undefined, { afterHold: true, crash: true });
    host.hold();
    await send("go");
    await host.until(() => host.messagesOf(bot).length === 1);
    host.release();

    const events = await (async () => {
      let seen = await pageEvents();
      for (let i = 0; i < 20 && !seen.some((e) => e.type === "error"); i++)
        seen = await pageEvents();
      return seen;
    })();
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(presenceOf(events)).toBe("idle");

    host.stopAsking();
    await send("again");
    await host.until(() => host.launches().length === 2);
    expect(host.launches()[1]?.argv).toContain(`--resume=${bot}`);
    await host.until(() => host.messagesOf(bot).length === 2);
    await settled(bot);
  });

  test("a routine run goes headless in a session of its own: the front gets nothing and the run reports through its output", async () => {
    const bot = await doubleLoopBot();
    const created = await host.ui("/api/routines/create", {
      botId: bot,
      name: "nightly",
      instruction: "check the weather",
      schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
    });
    const routine = (await created.json()) as { id: string };
    expect((await host.ui("/api/routines/run", { id: routine.id })).status).toBe(200);

    type Run = { status: string; output: string | null; sessionId: string | null };
    const runsOf = async () =>
      (await (await host.ui("/api/routines/runs", { id: routine.id })).json()) as Run[];
    for (let i = 0; i < 100 && (await runsOf())[0]?.status !== "succeeded"; i++)
      await Bun.sleep(50);
    const run = (await runsOf())[0];
    expect(run).toMatchObject({ status: "succeeded", output: "ok" });
    const session = run?.sessionId ?? "";
    expect(session).not.toBe("");
    expect(session).not.toBe(bot);
    expect(host.messagesOf(session)).toHaveLength(1);
    expect(host.messagesOf(session)[0]).toContain("<scheduled-routine");

    // The front's session, transcript and presence are as before the run.
    expect(host.messagesOf(bot)).toEqual([]);
    const events = await settled(bot);
    expect(events.some((e) => e.type === "routine")).toBe(false);
  });
});

describe("a double-loop bot's reloaded transcript", () => {
  const state =
    "<work_state>\nrunning (0 of 3 slots): (none)\nqueued: (none)\nrecent (last 3 ended): (none)\n</work_state>";

  test("shows what the user typed and what the bot said, without the work state, the app's own messages or the front's tool calls", async () => {
    const id = host.createBot("Dev");
    setChatMode(host.dataRoot, id, "double_loop");
    writeSession(host, id, [
      { role: "user", text: `what is up?\n\n${state}`, extra: { origin: { kind: "human" } } },
      {
        role: "assistant",
        text: "Not much.",
        blocks: [{ type: "tool_use", id: "tu-1", name: "Agent", input: { description: "x" } }],
      },
      {
        role: "user",
        text: `The app restarted. Nothing was running.\n\n${state}`,
        extra: { origin: { kind: "task-notification" } },
      },
      { role: "assistant", text: "Back." },
      { role: "user", text: `and now?\n\n${state}`, extra: { origin: { kind: "human" } } },
      { role: "assistant", text: "Same." },
    ]);

    expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
    const events = await pageEvents();
    const shown = events
      .filter((e) => e.type === "user" || e.type === "delta")
      .map((e) => `${e.type}: ${String(e.text)}`);
    expect(shown).toEqual([
      "user: what is up?",
      "delta: Not much.",
      "delta: Back.",
      "user: and now?",
      "delta: Same.",
    ]);
    expect(JSON.stringify(events.filter((e) => e.type !== "bots"))).not.toContain("work_state");
    expect(events.some((e) => e.type === "tool")).toBe(false);
    expect(presenceOf(events)).toBe("idle");
  });

  test("a session without work states is shown as before, whoever wrote its messages, tool calls included", async () => {
    const id = host.createBot("Dev");
    writeSession(host, id, [
      {
        role: "user",
        text: "plain <not a block>",
        extra: { origin: { kind: "task-notification" } },
      },
      {
        role: "assistant",
        text: "ok",
        blocks: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "a" } }],
      },
    ]);
    expect((await host.ui("/api/open", { id, botId: id })).status).toBe(200);
    const events = await pageEvents();
    expect(events.filter((e) => e.type === "user").map((e) => e.text)).toEqual([
      "plain <not a block>",
    ]);
    expect(events.filter((e) => e.type === "tool").map((e) => e.name)).toEqual(["Read"]);
  });
});
