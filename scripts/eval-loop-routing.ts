// Routing eval for the double-loop front: what does it do with one user message, given a work state? Ported from the v3
// prototype's eval/routing.ts, with the same 31 labelled cases and five scenarios.
//
//   bun run eval:loop-routing                  real model: 31 front turns, exits non-zero under 90% (EVAL_CONCURRENCY, default 4)
//   bun run eval:loop-routing --dry-run        prints the cases, the work states and the cost; starts nothing
//   bun run eval:loop-routing --cli <path> [--loop-json <file>]   a different Claude CLI, such as the fake one
//
// MANUAL: a run spends real model calls on the user's own Claude sign-in, found the way the host finds it (`resolveCli` for the
// CLI: CLAUDE_PATH, the managed install in the data root, then PATH; `ClaudeAccess` for its environment). No API key or token is
// read or printed here. It is not part of `bun run check`. `--data-root <dir>` names the host data root whose managed CLI to use
// (default: the OS application-data folder, or TOMTE_DATA_ROOT).
//
// Each case is a fresh `FrontSession` with the real options, prompt and tools, on a temp data root with a seeded SQLite store:
// the work state is the real `workState()` over the real `Observer.view()` of that store. Chat history is not replayed, so each
// case must be decidable from the message and <work_state> alone. Every tool call is recorded and refused by a PreToolUse hook,
// so no agent ever starts and the cost is front turns only. The first action is classified as `none`, `ask` (a reply ending in
// "?"), `start`, `queue`, `steer:<id>` or `cancel:<id>`.
//
// Cost: one fresh front session per case, so 31 sessions and 31 user turns on the front's own (small) model. A turn that calls a
// tool is two model requests (the call, then the close-out after the refusal); a text-only turn is one. `--dry-run` prints the
// split. The CLI writes each session's transcript under its config dir's projects/; the eval removes those of its own temp
// folder when it ends (a run that is killed leaves them behind).
//
// With the fake CLI (no model, no network) a case answers "none" unless `--loop-json` scripts it. The file has the fake's
// `loop.json` shape (`packages/host/src/testing/fake-claude.ts`); each case gets its own copy, so scripts `match` on the case's
// message text:
//   { "scripts": [{ "match": "stop that", "steps": [
//       { "text": "Dropping it now." },
//       { "emit": { "type": "assistant", "parent_tool_use_id": null, "message": { "role": "assistant", "content": [
//           { "type": "tool_use", "id": "toolu_1", "name": "TaskStop", "input": { "task_id": "a1b2c3d4e5f60718" } }] } } }] }] }
//   bun run eval:loop-routing --cli packages/host/src/testing/fake-claude.ts --loop-json loop.json
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_EFFORT, DEFAULT_MODEL } from "../packages/contract/src/events.ts";
import { createBot, frontContext, type HostDelegate } from "../packages/host/src/bots/index.ts";
import {
  claudeConfigDir,
  createClaudeAccess,
  resolveCli,
  type ClaudeAccess,
  type ResolvedCli,
} from "../packages/host/src/harness/index.ts";
import {
  CANCEL_QUEUED,
  ProgressAttribution,
  QUEUE_TASK,
  createLoopServer,
} from "../packages/host/src/loop/agents.ts";
import { FrontSession, type FrontOptions } from "../packages/host/src/loop/front.ts";
import { Observer } from "../packages/host/src/loop/observe.ts";
import { createLoopStore, type SessionLog } from "../packages/host/src/loop/store.ts";
import { Tasks } from "../packages/host/src/loop/tasks.ts";
import { MAX_PARALLEL, workState } from "../packages/host/src/loop/work-state.ts";
import { parseHostConfig } from "../packages/host/src/platform/config.ts";
import { migrate } from "../packages/host/src/platform/db.ts";
import { hostCommand } from "../packages/host/src/platform/launch.ts";

const A = "a1b2c3d4e5f60718";
const B = "b5e6f7a8091a2b3c";
const C = "c9d0e1f2a3b4c5d6";
const Q = "q-7f3a9c";

/** The eval refuses every tool call and answers no question, so no agent starts and nothing waits on a person. */
const refuseAll: HostDelegate = {
  askUser: async () => "No one can answer during this evaluation.",
  approve: async () => ({ behavior: "deny", message: "no tool runs during this evaluation" }),
};

/** A task row and its findings, as the store holds them; `agoMs` is how long before the run it started. */
type SeedTask = {
  taskId: string;
  goal: string;
  status: "running" | "queued";
  agoMs: number;
  after?: string;
  findings?: { text: string; agoMs: number }[];
};

const running = (
  taskId: string,
  goal: string,
  agoMs: number,
  findings: SeedTask["findings"] = [],
): SeedTask => ({ taskId, goal, status: "running", agoMs, findings });

const AGENTS_TASK = running(
  A,
  "How the major coding agents handle user messages sent mid-task",
  240_000,
  [
    {
      text: "Codex queues mid-task messages and applies them at the next turn boundary",
      agoMs: 120_000,
    },
    { text: "Claude Code lets you interrupt with Esc and send a correction", agoMs: 60_000 },
  ],
);
const PRICING_TASK = running(B, "What Cursor's plans cost: tiers, prices, limits", 90_000, [
  { text: "Cursor Pro is listed at $20 per month", agoMs: 30_000 },
]);

const SCENARIOS = {
  idle: [],
  one: [AGENTS_TASK],
  two: [AGENTS_TASK, PRICING_TASK],
  queued: [
    AGENTS_TASK,
    {
      taskId: Q,
      goal: "Best mechanical keyboards under $150",
      status: "queued",
      agoMs: 20_000,
      after: A,
    },
  ],
  full: [AGENTS_TASK, PRICING_TASK, running(C, "Best mechanical keyboards under $150", 40_000)],
} as const satisfies Record<string, readonly SeedTask[]>;

/** `none`: plain reply. `ask`: a clarifying question, no tool. Otherwise the first tool call. */
type Case = { scenario: keyof typeof SCENARIOS; text: string; expect: string[] };
const CASES: Case[] = [
  // A greeting may be answered with a question back; either way no tool is called.
  { scenario: "idle", text: "hey, how's it going?", expect: ["none", "ask"] },
  { scenario: "idle", text: "thanks!", expect: ["none"] },
  { scenario: "idle", text: "what's 12 * 12?", expect: ["none"] },
  {
    scenario: "idle",
    text: "research how the major coding agents handle messages sent mid-task",
    expect: ["start"],
  },
  {
    scenario: "idle",
    text: "can you dig into what Cursor costs? plans, prices, limits",
    expect: ["start"],
  },
  {
    scenario: "idle",
    text: "analyse the csv in the workspace and chart the monthly totals",
    expect: ["start"],
  },
  {
    scenario: "idle",
    text: "after that, look into mechanical keyboards",
    expect: ["start", "ask"],
  },
  { scenario: "one", text: "how's it going?", expect: ["none"] },
  { scenario: "one", text: "what have you found so far?", expect: ["none"] },
  { scenario: "one", text: "also cover Aider", expect: [`steer:${A}`] },
  { scenario: "one", text: "skip Cursor, focus on the CLI agents only", expect: [`steer:${A}`] },
  { scenario: "one", text: "make the report a comparison table", expect: [`steer:${A}`] },
  { scenario: "one", text: "separately, find out what Cursor costs", expect: ["start"] },
  {
    scenario: "one",
    text: "meanwhile, research the best mechanical keyboards under $150",
    expect: ["start"],
  },
  {
    scenario: "one",
    text: "after that, look into mechanical keyboards under $150",
    expect: ["queue"],
  },
  { scenario: "one", text: "once that's done, research standing desks", expect: ["queue"] },
  { scenario: "one", text: "stop that", expect: [`cancel:${A}`] },
  { scenario: "one", text: "never mind, cancel the research", expect: [`cancel:${A}`] },
  { scenario: "one", text: "nice, thanks", expect: ["none"] },
  {
    scenario: "two",
    text: "for the pricing one, include the team plan too",
    expect: [`steer:${B}`],
  },
  { scenario: "two", text: "on the coding agents research, add Aider", expect: [`steer:${A}`] },
  { scenario: "two", text: "drop the Cursor pricing task", expect: [`cancel:${B}`] },
  { scenario: "two", text: "cancel it", expect: ["ask"] },
  { scenario: "two", text: "what do you have on Cursor pricing so far?", expect: ["none"] },
  {
    scenario: "two",
    text: "after the pricing one, look into Windsurf pricing",
    expect: ["queue"],
  },
  { scenario: "two", text: "also research standing desks", expect: ["start"] },
  { scenario: "queued", text: "what's in your queue?", expect: ["none"] },
  { scenario: "queued", text: "forget the keyboards thing", expect: [`cancel:${Q}`] },
  { scenario: "queued", text: "stop the coding agents research", expect: [`cancel:${A}`] },
  { scenario: "full", text: "also research standing desks", expect: ["start", "queue"] },
  { scenario: "full", text: "how are things going?", expect: ["none"] },
];

/** A message of the front's Claude Code session, as the front hands it on. */
type SDKMessage = Parameters<FrontOptions["onMessage"]>[0];

const GATE = 0.9;
const CASE_TIMEOUT_MS = 120_000;
/** Tool calls of one turn after which the case is over: the first action is known and the rest only costs requests. */
const MAX_CALLS = 3;

const LABELS: Record<string, (input: Record<string, unknown>) => string> = {
  Agent: () => "start",
  [QUEUE_TASK]: () => "queue",
  SendMessage: (i) => `steer:${String(i.to)}`,
  TaskStop: (i) => `cancel:${String(i.task_id)}`,
  [CANCEL_QUEUED]: (i) => `cancel:${String(i.id)}`,
};

const textOnly = (c: Case) => c.expect.every((e) => e === "none" || e === "ask");

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    cli: { type: "string" },
    "loop-json": { type: "string" },
    "data-root": { type: "string" },
  },
  strict: true,
});

/** Writes the seeded session's tasks and findings to a fresh store, the way the host's observer would have left them. */
function seed(log: SessionLog, scenario: keyof typeof SCENARIOS, now: number) {
  const tasks: readonly SeedTask[] = SCENARIOS[scenario];
  for (const t of tasks) {
    log.putTask(
      {
        taskId: t.taskId,
        agentType: "researcher",
        ...(t.status === "running" && { model: "opus", effort: "high" }),
        goal: t.goal,
        status: t.status,
        startedAt: now - t.agoMs,
        ...(t.after !== undefined && { after: t.after }),
      },
      now - t.agoMs,
    );
    for (const f of t.findings ?? [])
      log.append({
        kind: "progress",
        taskId: t.taskId,
        at: now - f.agoMs,
        progress: { phase: "collecting sources", finding: f.text, next: "check the next vendor" },
      });
  }
}

/** The front's own Observer with a PreToolUse hook added that refuses every call, so nothing is ever executed. */
class DenyingObserver extends Observer {
  override get hooks(): Observer["hooks"] {
    const hooks = super.hooks;
    hooks.PreToolUse = [
      ...(hooks.PreToolUse ?? []),
      {
        hooks: [
          async (input) =>
            input.hook_event_name === "PreToolUse"
              ? {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: "Dry run: recorded, not executed. End the turn.",
                  },
                }
              : {},
        ],
      },
    ];
    return hooks;
  }
}

type Outcome = {
  got: string;
  ok: boolean;
  firstTextMs?: number | undefined;
  replyFirst?: boolean | undefined;
  text: string;
};

interface Env {
  /** A scratch folder holding every bot, memory file and working directory of the run. */
  root: string;
  cli: ResolvedCli;
  claude: ClaudeAccess;
  loopJson: string | undefined;
}

async function runCase(c: Case, n: number, env: Env): Promise<Outcome> {
  const bot = createBot(env.root, `Eval ${n}`, "A general assistant that researches things.");
  const { sessionId, persona, workerPersona, files, memory } = frontContext(env.root, bot);
  if (sessionId === undefined) throw new Error("the eval bot has no session");
  const cwd = join(env.root, "cwd");
  mkdirSync(cwd, { recursive: true });
  const fakeDir = join(env.root, `fake-${n}`);
  mkdirSync(fakeDir);
  if (env.loopJson) cpSync(env.loopJson, join(fakeDir, "loop.json"));

  const now = Date.now();
  const log = createLoopStore(migrate(new Database(":memory:"))).session(bot.id, sessionId);
  seed(log, c.scenario, now);
  const attribution = new ProgressAttribution();
  const tasks = new Tasks({
    log,
    maxParallel: MAX_PARALLEL,
    // Nothing here is due (the queued task waits for a running one) and nothing may talk to the front behind the case's back.
    dispatch: () => {
      throw new Error("the queue asked the front to start a task during an eval case");
    },
    emit: () => {},
    every: () => () => {},
  });
  // The observer reads the agent settings from the front, which is built after it.
  let front: FrontSession;
  const observer = new DenyingObserver({
    log,
    tasks,
    attribution,
    emit: () => {},
    changed: () => {},
    defaults: () => front.agentSettings,
    logLine: () => {},
  });

  const calls: string[] = [];
  const texts: string[] = [];
  let sentAt = 0;
  let firstTextMs: number | undefined;
  let replyFirst: boolean | undefined;
  const turn = Promise.withResolvers<void>();
  const failed = (e: Error) => turn.reject(e);

  const onMessage = (m: SDKMessage) => {
    observer.onMessage(m);
    if (m.type === "result") {
      if (m.is_error)
        failed(
          new Error(`the CLI reported an error: ${String("result" in m ? m.result : m.subtype)}`),
        );
      else turn.resolve();
      return;
    }
    if (m.type === "stream_event") {
      const e = m.event;
      if (
        m.parent_tool_use_id === null &&
        e.type === "content_block_delta" &&
        e.delta.type === "text_delta"
      )
        firstTextMs ??= Date.now() - sentAt;
      return;
    }
    if (m.type !== "assistant" || m.parent_tool_use_id !== null) return;
    for (const b of m.message.content) {
      if (b.type === "text") {
        texts.push(b.text);
        firstTextMs ??= Date.now() - sentAt;
      } else if (b.type === "tool_use") {
        replyFirst ??= texts.length > 0 || firstTextMs !== undefined;
        calls.push(LABELS[b.name]?.(b.input as Record<string, unknown>) ?? `tool:${b.name}`);
        if (calls.length >= MAX_CALLS) turn.resolve();
      }
    }
  };

  front = new FrontSession({
    cli: env.cli,
    claude: env.claude,
    cwd,
    sessionId,
    resume: false,
    hostServers: () => ({ servers: [], release: () => {} }),
    env: async () => ({ FAKE_CLAUDE_DIR: fakeDir }),
    delegate: refuseAll,
    log: () => {},
    persona,
    workerPersona,
    files,
    memory,
    // No integrations: the eval measures the front's routing, and every tool call is refused anyway.
    integrations: {
      session: async () => ({
        mcpServers: {},
        builtinServers: {},
        disallowedTools: [],
        plugins: [],
        policyOf: () => undefined,
        expiresAt: undefined,
      }),
      decide: () => undefined,
      prepareApproval: async (_name, input) => ({ input }),
      locked: () => false,
      reconcile: () => {},
    },
    agentSettings: { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT },
    observer,
    tasks,
    loopServer: createLoopServer({
      attribution,
      onProgress: () => {},
      queue: (goal, agentType, after) => tasks.queue(goal, agentType, after),
      cancelQueued: (id) => tasks.cancelQueued(id),
    }),
    onMessage,
    onEnd: failed,
  });

  const timer = setTimeout(
    () => failed(new Error(`timed out after ${CASE_TIMEOUT_MS / 1000}s`)),
    CASE_TIMEOUT_MS,
  );
  try {
    sentAt = Date.now();
    await front.send(c.text);
    await turn.promise;
  } finally {
    clearTimeout(timer);
    front.close();
    tasks.dispose();
  }
  const text = texts.join(" / ");
  const got = calls[0] ?? (text.trim().endsWith("?") ? "ask" : "none");
  return { got, ok: c.expect.includes(got), firstTextMs, replyFirst, text };
}

function costLine(): string {
  const withTool = CASES.filter((c) => !textOnly(c)).length;
  return `${CASES.length} cases = ${CASES.length} fresh front sessions, ${CASES.length} user turns; ${CASES.length - withTool} text-only turns (1 model request each) and ${withTool} turns expected to call a tool (about 2 requests each: the call, then the close-out after the refusal), so about ${CASES.length - withTool + 2 * withTool} requests on the front's model. No agent ever starts.`;
}

function dryRun() {
  const now = Date.now();
  for (const scenario of Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]) {
    const scratch = createLoopStore(migrate(new Database(":memory:"))).session("eval", scenario);
    seed(scratch, scenario, now);
    const observer = new Observer({
      log: scratch,
      tasks: new Tasks({
        log: scratch,
        maxParallel: MAX_PARALLEL,
        dispatch: () => {},
        emit: () => {},
        every: () => () => {},
      }),
      attribution: new ProgressAttribution(),
      emit: () => {},
      changed: () => {},
      defaults: () => ({ model: "opus", effort: "high" }),
      logLine: () => {},
    });
    console.log(`\n[${scenario}]\n${workState(observer.view())}`);
  }
  console.log("");
  for (const [i, c] of CASES.entries())
    console.log(
      `${String(i + 1).padStart(2)}  [${c.scenario}] ${JSON.stringify(c.text)} -> ${c.expect.join(" | ")}`,
    );
  console.log(`\ncost: ${costLine()}`);
}

async function main(): Promise<number> {
  if (args["dry-run"]) {
    dryRun();
    return 0;
  }
  const cliPath = args.cli ?? process.env.EVAL_CLI;
  const { config } = parseHostConfig(
    ["--mode", "local", ...(args["data-root"] ? ["--data-root", resolve(args["data-root"])] : [])],
    process.env,
  );
  const cli: ResolvedCli | undefined = cliPath
    ? { path: resolve(cliPath), source: "CLAUDE_PATH", needsShell: false }
    : resolveCli(config.dataRoot);
  if (!cli) {
    console.error(
      `No Claude CLI found (looked at CLAUDE_PATH, the managed install in ${config.dataRoot}, and PATH). Run \`${hostCommand("install-cli")}\` or pass --cli <path>.`,
    );
    return 2;
  }
  const root = mkdtempSync(join(tmpdir(), "tomte-loop-eval-"));
  // The fake CLI reads its directory from here for `auth status`; each case overrides it for its own session.
  process.env.FAKE_CLAUDE_DIR = join(root, "fake-auth");
  mkdirSync(process.env.FAKE_CLAUDE_DIR);
  const claude = createClaudeAccess(config, cli);
  try {
    if ((await claude.recheck("host-command")).state === "signed-out") {
      console.error(
        `Claude is not signed in (CLI ${cli.path}). Sign in with \`${hostCommand("auth-login")}\` and run the eval again.`,
      );
      return 2;
    }
    const env: Env = {
      root,
      cli,
      claude,
      loopJson: args["loop-json"] ? resolve(args["loop-json"]) : undefined,
    };
    console.error(`Claude CLI: ${cli.path} (${cli.source})`);
    const results: (Outcome | { error: string })[] = Array.from({ length: CASES.length }, () => ({
      error: "not run",
    }));
    let next = 0;
    let finished = 0;
    const concurrency = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? 4) || 4);
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < CASES.length) {
          const n = next++;
          const c = CASES[n]!;
          results[n] = await runCase(c, n, env).catch((err: Error) => ({ error: err.message }));
          console.error(`[${++finished}/${CASES.length}] ${c.scenario}: ${JSON.stringify(c.text)}`);
        }
      }),
    );

    console.log("\n  #  result  scenario  got  (expected)  first text  reply first  reply");
    for (const [i, c] of CASES.entries()) {
      const r = results[i]!;
      const head = `${String(i + 1).padStart(3)}  ${"error" in r ? "ERROR" : r.ok ? "ok   " : "FAIL "}  ${c.scenario.padEnd(6)}  ${JSON.stringify(c.text)}`;
      console.log(
        "error" in r
          ? `${head}  ${r.error}`
          : `${head}  → ${r.got}${r.ok ? "" : `  (expected ${c.expect.join(" | ")})`}  ${r.firstTextMs ?? "-"}ms  ${r.replyFirst === undefined ? "-" : r.replyFirst ? "yes" : "no"}  ${JSON.stringify(r.text.slice(0, 90))}`,
      );
    }

    const done = results.flatMap((r) => ("error" in r ? [] : [r]));
    const passed = done.filter((r) => r.ok).length;
    const latencies = done
      .flatMap((r) => (r.firstTextMs === undefined ? [] : [r.firstTextMs]))
      .sort((a, b) => a - b);
    const withTool = done.filter((r) => r.replyFirst !== undefined);
    console.log(
      `\nrouting: ${passed}/${CASES.length} correct (${Math.round((100 * passed) / CASES.length)}%), ${CASES.length - done.length} errors, gate ${GATE * 100}%`,
    );
    if (latencies.length)
      console.log(
        `first text: p50 ${latencies[Math.floor(latencies.length / 2)]} ms, p90 ${latencies[Math.floor(latencies.length * 0.9)]} ms (each case is a cold session)`,
      );
    console.log(
      `reply before the tool call: ${withTool.filter((r) => r.replyFirst).length}/${withTool.length} turns with a tool call`,
    );
    return passed / CASES.length >= GATE ? 0 : 1;
  } finally {
    // The CLI keeps each session's transcript under the config dir; drop those of this run's own folder.
    const projects = join(claudeConfigDir(config), "projects");
    const mine = basename(root).replace(/[^a-zA-Z0-9]/g, "-");
    try {
      for (const d of readdirSync(projects))
        if (d.includes(mine)) rmSync(join(projects, d), { recursive: true, force: true });
    } catch {
      // No projects folder: nothing was written.
    }
    rmSync(root, { recursive: true, force: true });
  }
}

process.exit(await main());
