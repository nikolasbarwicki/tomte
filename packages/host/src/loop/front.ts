import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  query,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "@claudebot/contract/api";
import type { MemoryScope } from "@claudebot/contract/events";

import {
  Inbox,
  MEMORY_INSTRUCTIONS,
  createCanUseTool,
  createHostMcpServer,
  memorySections,
  type HostDelegate,
  type MemoryPaths,
} from "../bots/index.ts";
import {
  claudeHarness,
  cmdExeSpawner,
  type ClaudeAccess,
  type HostServerLease,
  type ResolvedCli,
} from "../harness/index.ts";
import {
  AGENT_BUILTIN_TOOLS,
  FRONT_AGENT,
  LOOP_SERVER,
  RECORD_PROGRESS,
  agentDefinitions,
  type AgentSettings,
} from "./agents.ts";
import type { Observer } from "./observe.ts";
import { FRONT_PROMPT } from "./prompt.ts";
import { MAX_PARALLEL, workState } from "./work-state.ts";

/** The built-in tools only the front uses; agents have their own. */
const FRONT_TOOLS = ["Agent", "SendMessage", "TaskStop"];

/** Tools the front and its agents use without asking: the front's own, agents' web research and their progress recorder. */
const PRE_APPROVED = [...FRONT_TOOLS, ...AGENT_BUILTIN_TOOLS, RECORD_PROGRESS];

/** The front answers in seconds and never needs to think, whatever model the bot itself is set to; the bot's model drives the background agents. */
const FRONT_MODEL = "claude-haiku-5-5";

export interface FrontOptions {
  cli: ResolvedCli;
  claude: ClaudeAccess;
  cwd: string;
  sessionId: string;
  /** True when this session id already has a transcript on disk. */
  resume: boolean;
  /** Leases the host servers the front may use; released when the query closes. */
  hostServers: () => HostServerLease;
  /** Extra environment variables for the CLI, added to `claude.env()`; read whenever a query opens. */
  env?: () => Promise<Record<string, string>>;
  idleMs?: number;
  approveAll?: boolean;
  delegate: HostDelegate;
  log?: (line: string) => void;
  /** Who the bot is; appended to the system prompt. */
  persona: string;
  memory: MemoryPaths;
  /** Called with a scope's full memory file after the front changes it. */
  onMemory?: (scope: MemoryScope, text: string) => void;
  /** Turns the session's messages and hooks into task rows and reports, and says what the work state lists. */
  observer: Observer;
  /** The in-process `loop` MCP server agents report progress to. */
  loopServer: McpSdkServerConfigWithInstance;
  /** Every SDK message of the session, in order. A throw is logged and never ends the session. */
  onMessage: (m: SDKMessage) => void;
  /** The CLI process ended without `close()`: the next `send()` reopens the session with `resume`. */
  onEnd: (error: Error) => void;
  /** The CLI process is gone, closed or ended, and every agent it ran with it. */
  onStopped?: () => void;
}

type Live = { q: Query; input: Inbox; lease: HostServerLease };

/**
 * One long-lived Claude Code session per double-loop bot. Shaped like `Thread`, but a pump consumes the query's messages for
 * the session's whole life instead of one turn at a time, and messages are pushed as they come: `priority: "next"` makes the
 * CLI take a message mid-turn instead of waiting for the turn to end.
 */
export class FrontSession {
  private started: boolean;
  private live?: Live | undefined;
  private opening?: Promise<Live> | undefined;
  /** Bumped by `close()`, so an open still in flight knows it was closed under it. */
  private generation = 0;
  /** True from a message being sent until its `result`. */
  private turn = false;
  private idleTimer?: NodeJS.Timeout | undefined;
  private readonly canUseTool: CanUseTool;
  private settings: AgentSettings = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
  private readonly log: (line: string) => void;

  /** What the session's messages mean to the chat: the tasks it runs and the reports it owes. */
  readonly observer: Observer;

  constructor(private readonly o: FrontOptions) {
    this.observer = o.observer;
    this.started = o.resume;
    this.log = o.log ?? ((l) => console.error(l));
    const base = createCanUseTool({
      cwd: o.cwd,
      roots: [resolve(o.cwd)],
      approveAll: o.approveAll,
      delegate: o.delegate,
    });
    // Nobody answers a permission prompt for an agent's web research or for the front's own agent calls, so those never ask.
    this.canUseTool = (name, input, options) =>
      PRE_APPROVED.includes(name)
        ? Promise.resolve({ behavior: "allow", updatedInput: input })
        : base(name, input, options);
  }

  private async open(): Promise<Live> {
    const generation = this.generation;
    const input = new Inbox();
    await this.o.claude.requireSignIn();
    const lease = this.o.hostServers();
    const append =
      FRONT_PROMPT +
      `\n\n${MEMORY_INSTRUCTIONS}` +
      (lease.instructions ? `\n\n${lease.instructions}` : "") +
      `\n\n${this.o.persona}` +
      memorySections(this.o.memory);
    const launch = claudeHarness.launch({
      hostServers: lease.servers,
      systemPromptAppend: append,
      isolation: lease.isolation,
    });
    let live: Live;
    try {
      const q = query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: this.o.cli.path,
          ...(this.o.cli.needsShell ? { spawnClaudeCodeProcess: cmdExeSpawner } : {}),
          cwd: this.o.cwd,
          ...(this.started ? { resume: this.o.sessionId } : { sessionId: this.o.sessionId }),
          persistSession: true,
          includePartialMessages: true,
          canUseTool: this.canUseTool,
          // The front never blocks on the user, so its host server has no ask_user.
          mcpServers: {
            host: createHostMcpServer({
              memory: this.o.memory,
              onMemory: this.o.onMemory,
              log: this.log,
            }),
            [LOOP_SERVER]: this.o.loopServer,
          },
          ...launch.options,
          // The session's tools hold every agent's tools, because subagents only see what the session has; the main thread runs as
          // the `front` agent, whose own tool set leaves the agents' tools out.
          tools: [...FRONT_TOOLS, ...AGENT_BUILTIN_TOOLS],
          agent: "front",
          agents: { ...agentDefinitions(this.settings), front: FRONT_AGENT },
          agentProgressSummaries: true,
          hooks: this.observer.hooks,
          model: FRONT_MODEL,
          thinking: { type: "disabled" },
          env: {
            ...this.o.claude.env(),
            ...(await this.o.env?.()),
            CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1",
            CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(MAX_PARALLEL),
          },
          stderr: (d) => this.log(`[cli stderr] ${d.trimEnd()}`),
        },
      });
      try {
        await q.initializationResult();
      } catch (e) {
        q.close();
        throw e;
      }
      live = { q, input, lease };
    } catch (e) {
      lease.release();
      throw e;
    } finally {
      launch.dispose();
    }
    if (generation !== this.generation) {
      this.release(live);
      throw new Error("front session closed while opening");
    }
    this.started = true;
    this.live = live;
    void this.pump(live);
    this.log(
      `[host] front opened (${this.o.resume ? "resume" : "new"}) session=${this.o.sessionId}`,
    );
    return live;
  }

  private ensureOpen(): Promise<Live> {
    if (this.live) return Promise.resolve(this.live);
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  /** Reads the query until it ends. A message the handler chokes on is logged and skipped; only the process going away ends the session. */
  private async pump(live: Live) {
    let failure: Error;
    try {
      for await (const m of live.q) {
        this.observe(m);
        try {
          this.o.onMessage(m);
        } catch (e) {
          this.log(`[host] front message handler failed: ${(e as Error).message}`);
        }
      }
      failure = new Error("Claude Code exited");
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e));
    }
    if (this.live !== live) return;
    clearTimeout(this.idleTimer);
    this.live = undefined;
    this.turn = false;
    this.release(live);
    this.log(
      `[host] front ended (${failure.message}); next send resumes session=${this.o.sessionId}`,
    );
    this.o.onEnd(failure);
  }

  private observe(m: SDKMessage) {
    if (m.type === "result") {
      this.turn = false;
      this.armIdle();
    } else if (m.type === "stream_event" || m.type === "assistant") this.turn = true;
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    if (!this.o.idleMs || !this.live) return;
    this.idleTimer = setTimeout(() => this.idleClose(), this.o.idleMs).unref();
  }

  /** The one place a rule about what must outlive an idle front belongs: it stays open while a turn is running or an agent runs, since closing it kills the agents. */
  private mayClose(): boolean {
    return !this.turn && this.observer.running() === 0;
  }

  /** Model and effort the background agents run on; they apply to agents defined when the session next opens. */
  setAgentSettings(patch: Partial<AgentSettings>) {
    this.settings = { ...this.settings, ...patch };
  }

  get agentSettings(): AgentSettings {
    return this.settings;
  }

  private idleClose() {
    if (this.mayClose()) this.close("idle");
    else this.armIdle();
  }

  /** Gives the session a message and returns once it is queued; the reply arrives through `onMessage`. `synthetic` marks a message the app wrote, not the user. */
  async send(text: string, synthetic = false): Promise<void> {
    clearTimeout(this.idleTimer);
    const live = await this.ensureOpen();
    if (this.live !== live) throw new Error("front session closed before the message was sent");
    this.turn = true;
    live.input.push({
      type: "user",
      message: {
        role: "user",
        content: `${text}\n\n${workState(this.observer.view())}`,
      },
      parent_tool_use_id: null,
      priority: "next",
      uuid: randomUUID(),
      ...(synthetic ? { isSynthetic: true } : { origin: { kind: "human" as const } }),
    });
  }

  /** Context window usage of the live query; undefined while the CLI is not running. */
  async contextUsage(): Promise<{ tokens: number; max: number; percentage: number } | undefined> {
    if (!this.live) return undefined;
    const u = await this.live.q.getContextUsage({ detail: "summary" });
    return { tokens: u.totalTokens, max: u.rawMaxTokens, percentage: u.percentage };
  }

  private release(live: Live) {
    live.input.end();
    live.q.close();
    live.lease.release();
    this.o.onStopped?.();
  }

  close(reason = "close") {
    this.generation++;
    this.opening = undefined;
    clearTimeout(this.idleTimer);
    this.turn = false;
    const live = this.live;
    if (!live) return;
    this.live = undefined;
    this.release(live);
    this.log(`[host] front closed (${reason}); next send resumes session=${this.o.sessionId}`);
  }
}
