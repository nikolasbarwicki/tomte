import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type EffortLevel,
  type McpServerConfig,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { cmdExeSpawner, loginShellPath, type ResolvedCli } from "./cli.ts";

export const APP = "claudebot";
export const VERSION = "0.1.0";

/** Decisions the host (its UI/user) owns. */
export interface HostDelegate {
  askUser(question: string): Promise<string>;
  /** Bash, or file writes outside the thread's roots. */
  approve(toolName: string, input: Record<string, unknown>, reason: string): Promise<PermissionResult>;
}

export interface ThreadOptions {
  cli: ResolvedCli;
  cwd: string;
  sessionId?: string;
  /** True when this session id already has a transcript on disk. */
  resume?: boolean;
  additionalDirectories?: string[];
  externalMcpServers?: Record<string, McpServerConfig>;
  model?: string;
  idleMs?: number;
  /** Run every tool without asking the delegate. */
  approveAll?: boolean;
  delegate: HostDelegate;
  log?: (line: string) => void;
}

const HOST_INSTRUCTIONS = [
  "You are embedded in a local host application.",
  "When you need a decision or information from the user, call the mcp__host__ask_user tool instead of guessing.",
  "Use mcp__host__remember to persist durable facts the user wants kept.",
  "",
  "## Other coding agents (herdr)",
  "The user runs other coding agents (omp, Claude Code, Codex, …) in herdr, a terminal multiplexer. Messages wrapped in <external-update> are status updates from them, not from the user.",
  "You can inspect and talk to those agents with the `herdr` CLI through Bash. Every command prints JSON. Agents are addressed by pane id (e.g. w1:p2) or agent name.",
  "- `herdr agent list` — all agents with pane_id, agent, agent_status (idle/working/blocked/done/unknown) and cwd.",
  "- `herdr agent get <pane>` — one agent's details.",
  "- `herdr agent read <pane>` or `herdr pane read <pane> --source recent --lines 80` — what the agent's terminal currently shows; use this to see what it did or what it is asking.",
  "- `herdr agent prompt <pane> \"<text>\"` — send the agent a message; add `--wait` to block until it settles. Fails with agent_blocked if it is waiting on a dialog.",
  "- `herdr agent send-keys <pane> <keys…>` — answer an approval/question dialog, e.g. `enter`, `esc`, `up`, `down`, `ctrl+c`.",
  "- `herdr agent wait <pane> --until done --until idle --until blocked` — wait for it to settle.",
  "Reading (list/get/read) is safe: do it freely when the user asks about the other agents or an update needs context.",
  "Sending input (prompt/send-keys) acts on another agent: only do it when the user asked for it or confirmed via mcp__host__ask_user, and read the pane first so you answer the right dialog.",
].join("\n");

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Push-based async iterable feeding later turns into the same live query. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private done = false;
  push(m: SDKUserMessage) {
    this.queue.push(m);
    this.wake?.();
  }
  end() {
    this.done = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

export interface TurnResult {
  result: SDKResultMessage & { subtype: "success" };
  text: string;
  toolsUsed: string[];
}

export class Thread {
  readonly sessionId: string;
  private started: boolean;
  private live?: { q: Query; inbox: Inbox; it: AsyncIterator<SDKMessage> };
  private idleTimer?: NodeJS.Timeout;
  private busy = false;
  private model?: string;
  private effort?: EffortLevel;
  private readonly roots: string[];
  private readonly log: (l: string) => void;

  constructor(private readonly o: ThreadOptions) {
    this.sessionId = o.sessionId ?? randomUUID();
    this.started = !!o.resume;
    this.model = o.model;
    this.roots = [o.cwd, ...(o.additionalDirectories ?? [])].map((d) => resolve(d));
    this.log = o.log ?? ((l) => console.error(l));
  }

  private inRoots(p: unknown): boolean {
    if (typeof p !== "string") return false;
    const abs = resolve(this.o.cwd, p);
    return this.roots.some((r) => {
      const rel = relative(r, abs);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  }

  private canUseTool: CanUseTool = async (name, input) => {
    if (this.o.approveAll || name.startsWith("mcp__host__")) return { behavior: "allow", updatedInput: input };
    const path = input.file_path ?? input.notebook_path ?? input.path;
    if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
      if (path === undefined || this.inRoots(path)) return { behavior: "allow", updatedInput: input };
      if (READ_TOOLS.has(name)) return this.o.delegate.approve(name, input, `read outside workspace: ${path}`);
      return this.o.delegate.approve(name, input, `write outside workspace: ${path}`);
    }
    if (name === "Bash") return this.o.delegate.approve(name, input, "shell command");
    return this.o.delegate.approve(name, input, "tool requires approval");
  };

  private hostServer() {
    const cwd = this.o.cwd;
    const delegate = this.o.delegate;
    const log = this.log;
    return createSdkMcpServer({
      name: "host",
      version: VERSION,
      tools: [
        tool("ask_user", "Ask the human user a question and wait for their answer.", { question: z.string() }, async ({ question }) => {
          log(`[host] ask_user invoked in-process: ${JSON.stringify(question)}`);
          const answer = await delegate.askUser(question);
          return { content: [{ type: "text", text: answer }] };
        }),
        tool("remember", "Append one line to the workspace memory file.", { line: z.string() }, async ({ line }) => {
          const dir = join(cwd, ".host");
          mkdirSync(dir, { recursive: true });
          appendFileSync(join(dir, "memory.md"), line.replace(/\n/g, " ") + "\n");
          return { content: [{ type: "text", text: "saved" }] };
        }),
      ],
    });
  }

  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    env.PATH = loginShellPath();
    env.CLAUDE_AGENT_SDK_CLIENT_APP = `${APP}/${VERSION}`;
    if (this.o.cli.source === "managed") env.DISABLE_AUTOUPDATER = "1";
    else delete env.DISABLE_AUTOUPDATER;
    return env;
  }

  private async open() {
    const inbox = new Inbox();
    let mcpFile: string | undefined;
    const extraArgs: Record<string, string | null> = {};
    if (this.o.externalMcpServers && Object.keys(this.o.externalMcpServers).length) {
      mcpFile = join(tmpdir(), `${APP}-mcp-${randomUUID()}.json`);
      writeFileSync(mcpFile, JSON.stringify({ mcpServers: this.o.externalMcpServers }), { mode: 0o600 });
      chmodSync(mcpFile, 0o600);
      extraArgs["mcp-config"] = mcpFile;
    }
    const q = query({
      prompt: inbox,
      options: {
        pathToClaudeCodeExecutable: this.o.cli.path,
        ...(this.o.cli.needsShell ? { spawnClaudeCodeProcess: cmdExeSpawner } : {}),
        cwd: this.o.cwd,
        additionalDirectories: this.o.additionalDirectories,
        ...(this.started ? { resume: this.sessionId } : { sessionId: this.sessionId }),
        persistSession: true,
        systemPrompt: { type: "preset", preset: "claude_code", append: HOST_INSTRUCTIONS },
        includePartialMessages: true,
        permissionMode: "default",
        canUseTool: this.canUseTool,
        strictMcpConfig: true,
        settingSources: ["user"],
        mcpServers: { host: this.hostServer() },
        extraArgs,
        disallowedTools: [],
        model: this.model,
        env: this.env(),
        stderr: (d) => this.log(`[cli stderr] ${d.trimEnd()}`),
      },
    });
    try {
      await q.initializationResult();
    } catch (e) {
      q.close();
      throw e;
    } finally {
      if (mcpFile) rmSync(mcpFile, { force: true });
    }
    if (this.effort) await q.applyFlagSettings({ effortLevel: this.effort });
    this.started = true;
    this.live = { q, inbox, it: q[Symbol.asyncIterator]() };
    this.log(`[host] query opened (${this.o.resume ? "resume" : "new"}) session=${this.sessionId}`);
  }

  async send(text: string, onEvent?: (m: SDKMessage) => void): Promise<TurnResult> {
    if (this.busy) throw new Error("a turn is already running on this thread");
    this.busy = true;
    clearTimeout(this.idleTimer);
    try {
      if (!this.live) await this.open();
      const { inbox, it } = this.live!;
      inbox.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
      let out = "";
      const toolsUsed: string[] = [];
      while (true) {
        const { value: m, done } = await it.next();
        if (done) throw new Error("Claude Code exited before the turn produced a result");
        onEvent?.(m);
        if (m.type === "assistant") {
          for (const b of m.message.content) {
            if (b.type === "text") out += b.text;
            if (b.type === "tool_use") toolsUsed.push(b.name);
          }
        }
        if (m.type === "result") {
          if (m.subtype !== "success" || m.is_error) {
            const detail = "errors" in m ? m.errors.join("; ") : m.result;
            throw new Error(`turn failed (${m.subtype}): ${detail}`);
          }
          return { result: m, text: m.result || out, toolsUsed };
        }
      }
    } catch (e) {
      this.close();
      throw e;
    } finally {
      this.busy = false;
      if (this.live && this.o.idleMs) this.idleTimer = setTimeout(() => this.close("idle"), this.o.idleMs).unref();
    }
  }

  async setModel(model: string) {
    this.model = model;
    if (!this.live) return this.log(`[host] model=${model} recorded; applies on next open`);
    await this.live.q.setModel(model);
    this.log(`[host] setModel(${model}) called on live query session=${this.sessionId}`);
  }

  async setEffort(effort: EffortLevel) {
    this.effort = effort;
    if (!this.live) return;
    await this.live.q.applyFlagSettings({ effortLevel: effort });
    this.log(`[host] applyFlagSettings(effortLevel=${effort}) on live query`);
  }

  get isLive() {
    return !!this.live;
  }

  close(reason = "close") {
    clearTimeout(this.idleTimer);
    if (!this.live) return;
    this.live.inbox.end();
    this.live.q.close();
    this.live = undefined;
    this.log(`[host] query closed (${reason}); next send resumes session=${this.sessionId}`);
  }
}
