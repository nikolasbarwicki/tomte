import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";

import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type EffortLevel,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { MemoryScope } from "@claudebot/contract/events";
import { z } from "zod";

import {
  VERSION,
  claudeHarness,
  cmdExeSpawner,
  type ClaudeAccess,
  type HostServerLease,
  type HostServersSource,
  type ResolvedCli,
} from "../harness/index.ts";
import type { IntegrationsSource } from "../integrations/index.ts";
import { appendMemory, readMemory, writeMemory, type MemoryPaths } from "./memory.ts";

/** Decisions the host (its UI/user) owns. */
export interface HostDelegate {
  askUser(question: string): Promise<string>;
  /** Bash, or file writes outside the thread's roots. */
  approve(
    toolName: string,
    input: Record<string, unknown>,
    reason: string,
  ): Promise<PermissionResult>;
}

/** What every bot thread the host opens shares, whether in a chat or in a headless routine run. */
export interface ThreadEnv {
  /** The workspace directory the Claude CLI runs in. */
  cwd: string;
  /** Where bots, their memory and the user memory live. */
  dataRoot: string;
  cli: ResolvedCli;
  /** The environment and sign-in every Claude CLI child runs with. */
  claude: ClaudeAccess;
  integrations: IntegrationsSource;
  hostServers: HostServersSource;
  /** Approve every tool call instead of asking the user; off when `HostConfig.askApproval` is set. */
  approveAll: boolean;
}

export interface ThreadOptions {
  cli: ResolvedCli;
  claude: ClaudeAccess;
  cwd: string;
  sessionId?: string | undefined;
  /** True when this session id already has a transcript on disk. */
  resume?: boolean;
  additionalDirectories?: string[];
  /** Asked for its session configuration whenever a live query opens, and for a decision on every integration tool call. */
  integrations?: IntegrationsSource;
  /** Leases the host servers (such as the browser endpoint) for each live query; released when that query closes. */
  hostServers?: () => HostServerLease;
  model?: string;
  idleMs?: number;
  /** Run every tool without asking the delegate. */
  approveAll?: boolean;
  delegate: HostDelegate;
  log?: (line: string) => void;
  /** Who this thread is; appended to the system prompt. */
  persona?: string;
  memory: MemoryPaths;
  /** Called with a scope's full memory file after the agent changes it. */
  onMemory?: (scope: MemoryScope, text: string) => void;
}

const HOST_INSTRUCTIONS = [
  "You are embedded in a local host application.",
  "When you need a decision or information from the user, call the mcp__host__ask_user tool instead of guessing.",
  "",
  "## Memory",
  "Two memory files are loaded into this prompt whenever the session opens:",
  '- user memory (scope "user"): shared by every bot. Durable facts about the user: who they are, their background, environment, and general preferences that apply to any task.',
  '- bot memory (scope "bot"): only this bot. How this bot should operate: directions, workflow, rules, output format, tone, priorities and boundaries for its job.',
  'When the user tells you how to do your work (do/don\'t, always/never, format, process, style, which tools or sources to use), save it right away with mcp__host__remember scope "bot"; do not ask first. When they reveal a durable fact or general preference about themselves, save it with scope "user". If unsure whether a preference is general or specific to this bot\'s job, use "bot".',
  "Write each entry as one concise, self-contained line. Do not save one-off task details or anything already in memory. When a direction changes or contradicts an existing entry, call mcp__host__rewrite_memory with the complete corrected file for that scope instead of appending.",
  "Mention briefly what you saved.",
].join("\n");

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Push-based async iterable feeding later turns into the same live query. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake?: (() => void) | undefined;
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
  private live?:
    | {
        q: Query;
        inbox: Inbox;
        it: AsyncIterator<SDKMessage>;
        expiresAt?: number | undefined;
        lease?: HostServerLease | undefined;
      }
    | undefined;
  private idleTimer?: NodeJS.Timeout;
  private busy = false;
  /** Set when `close()` lands while `send()` is still opening the query, which `close()` alone cannot reach. */
  private closedMidSend = false;
  private model?: string | undefined;
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
    if (
      name.startsWith("mcp__host__") ||
      name.startsWith("mcp__browser__") ||
      name.startsWith("mcp__bots__")
    )
      return { behavior: "allow", updatedInput: input };
    switch (this.o.integrations?.decide(name)) {
      case "allow":
        return { behavior: "allow", updatedInput: input };
      case "deny":
        return { behavior: "deny", message: "this tool is switched off in Integrations" };
      case "ask":
        return this.o.delegate.approve(name, input, "integration tool");
    }
    if (this.o.approveAll) return { behavior: "allow", updatedInput: input };
    const path = input.file_path ?? input.notebook_path ?? input.path;
    if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
      if (path === undefined || this.inRoots(path))
        return { behavior: "allow", updatedInput: input };
      const shown = typeof path === "string" ? path : JSON.stringify(path);
      if (READ_TOOLS.has(name))
        return this.o.delegate.approve(name, input, `read outside workspace: ${shown}`);
      return this.o.delegate.approve(name, input, `write outside workspace: ${shown}`);
    }
    if (name === "Bash") return this.o.delegate.approve(name, input, "shell command");
    return this.o.delegate.approve(name, input, "tool requires approval");
  };

  private hostServer() {
    const { delegate, memory, onMemory } = this.o;
    const log = this.log;
    const scope = z
      .enum(["user", "bot"])
      .describe('"user": about the user, shared by all bots; "bot": how this bot should operate');
    return createSdkMcpServer({
      name: "host",
      version: VERSION,
      tools: [
        tool(
          "ask_user",
          "Ask the human user a question and wait for their answer.",
          { question: z.string() },
          async ({ question }) => {
            log(`[host] ask_user invoked in-process: ${JSON.stringify(question)}`);
            const answer = await delegate.askUser(question);
            return { content: [{ type: "text", text: answer }] };
          },
        ),
        tool(
          "remember",
          "Append one line to user or bot memory.",
          { scope, line: z.string() },
          async ({ scope, line }) => {
            appendMemory(memory[scope], line);
            onMemory?.(scope, readMemory(memory[scope]));
            return { content: [{ type: "text", text: `saved to ${scope} memory` }] };
          },
        ),
        tool(
          "rewrite_memory",
          "Replace the whole user or bot memory file, to revise or drop entries. Pass the complete new content, one entry per line.",
          { scope, text: z.string() },
          async ({ scope, text }) => {
            writeMemory(memory[scope], text);
            onMemory?.(scope, readMemory(memory[scope]));
            return { content: [{ type: "text", text: `${scope} memory rewritten` }] };
          },
        ),
      ],
    });
  }

  private async open() {
    const inbox = new Inbox();
    await this.o.claude.requireSignIn();
    const session = await this.o.integrations?.session();
    const lease = this.o.hostServers?.();
    const section = (title: string, path: string) => {
      const text = readMemory(path).trim();
      return text ? `\n\n# ${title}\n${text}` : "";
    };
    const append =
      HOST_INSTRUCTIONS +
      (lease?.instructions ? `\n\n${lease.instructions}` : "") +
      (this.o.persona ? `\n\n${this.o.persona}` : "") +
      section("User memory (about the user)", this.o.memory.user) +
      section("Bot memory (how you operate)", this.o.memory.bot);
    const launch = claudeHarness.launch({
      hostServers: lease?.servers ?? [],
      integrations: session,
      systemPromptAppend: append,
      isolation: lease?.isolation,
    });
    try {
      const q = query({
        prompt: inbox,
        options: {
          pathToClaudeCodeExecutable: this.o.cli.path,
          ...(this.o.cli.needsShell ? { spawnClaudeCodeProcess: cmdExeSpawner } : {}),
          cwd: this.o.cwd,
          ...(this.o.additionalDirectories !== undefined && {
            additionalDirectories: this.o.additionalDirectories,
          }),
          ...(this.started ? { resume: this.sessionId } : { sessionId: this.sessionId }),
          persistSession: true,
          includePartialMessages: true,
          canUseTool: this.canUseTool,
          mcpServers: { host: this.hostServer() },
          ...launch.options,
          ...(this.model !== undefined && { model: this.model }),
          env: this.o.claude.env(),
          stderr: (d) => this.log(`[cli stderr] ${d.trimEnd()}`),
        },
      });
      try {
        await q.initializationResult();
      } catch (e) {
        q.close();
        throw e;
      }
      if (this.effort) await q.applyFlagSettings({ effortLevel: this.effort });
      this.started = true;
      this.live = { q, inbox, it: q[Symbol.asyncIterator](), expiresAt: session?.expiresAt, lease };
    } catch (e) {
      lease?.release();
      throw e;
    } finally {
      launch.dispose();
    }
    this.log(`[host] query opened (${this.o.resume ? "resume" : "new"}) session=${this.sessionId}`);
    await this.reconcileIntegrations();
  }

  private async reconcileIntegrations() {
    if (!this.o.integrations || !this.live) return;
    try {
      this.o.integrations.reconcile(await this.live.q.mcpServerStatus());
    } catch (e) {
      this.log(`[host] mcpServerStatus failed: ${(e as Error).message}`);
    }
  }

  async send(text: string, onEvent?: (m: SDKMessage) => void): Promise<TurnResult> {
    if (this.busy) throw new Error("a turn is already running on this thread");
    this.busy = true;
    this.closedMidSend = false;
    clearTimeout(this.idleTimer);
    try {
      if (this.live?.expiresAt !== undefined && Date.now() >= this.live.expiresAt) {
        this.close("integration token expiring");
        this.closedMidSend = false;
      }
      if (!this.live) await this.open();
      if (this.closedMidSend) throw new Error("thread closed while opening");
      const { inbox, it } = this.live!;
      inbox.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
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
          await this.reconcileIntegrations();
          return { result: m, text: m.result || out, toolsUsed };
        }
      }
    } catch (e) {
      this.close();
      throw e;
    } finally {
      this.busy = false;
      if (this.live && this.o.idleMs)
        this.idleTimer = setTimeout(() => this.close("idle"), this.o.idleMs).unref();
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

  /** Context window usage of the live query; undefined while the CLI is not running. */
  async contextUsage(): Promise<{ tokens: number; max: number; percentage: number } | undefined> {
    if (!this.live) return undefined;
    const u = await this.live.q.getContextUsage({ detail: "summary" });
    return { tokens: u.totalTokens, max: u.rawMaxTokens, percentage: u.percentage };
  }

  get isLive() {
    return !!this.live;
  }

  close(reason = "close") {
    clearTimeout(this.idleTimer);
    if (this.busy) this.closedMidSend = true;
    if (!this.live) return;
    this.live.inbox.end();
    this.live.q.close();
    this.live.lease?.release();
    this.live = undefined;
    this.log(`[host] query closed (${reason}); next send resumes session=${this.sessionId}`);
  }
}
