import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  query,
  type CanUseTool,
  type EffortLevel,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type MemoryScope } from "@claudebot/contract/events";

import {
  claudeHarness,
  cmdExeSpawner,
  type ClaudeAccess,
  type HostServerLease,
  type HostServersSource,
  type ResolvedCli,
} from "../harness/index.ts";
import type { IntegrationsSource } from "../integrations/index.ts";
import { type MemoryPaths } from "./memory.ts";
import {
  ASK_INSTRUCTIONS,
  Inbox,
  MEMORY_INSTRUCTIONS,
  createCanUseTool,
  createHostMcpServer,
  memorySections,
  type HostDelegate,
} from "./session-kit.ts";

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
  /** Extra environment variables for the Claude CLI of one bot, such as where it posts external events. Read whenever a session opens. */
  botEnv: (botId: string) => Promise<Record<string, string>>;
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
  /** Extra environment variables for the CLI, added to `claude.env()`; read whenever a live query opens. */
  env?: () => Promise<Record<string, string>>;
  model?: string;
  effort?: EffortLevel;
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

const HOST_INSTRUCTIONS = `${ASK_INSTRUCTIONS}\n\n${MEMORY_INSTRUCTIONS}`;

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
  private model: string;
  private effort: EffortLevel;
  private readonly canUseTool: CanUseTool;
  private readonly log: (l: string) => void;

  constructor(private readonly o: ThreadOptions) {
    this.sessionId = o.sessionId ?? randomUUID();
    this.started = !!o.resume;
    this.model = o.model ?? DEFAULT_MODEL;
    this.effort = o.effort ?? DEFAULT_EFFORT;
    this.canUseTool = createCanUseTool({
      cwd: o.cwd,
      roots: [o.cwd, ...(o.additionalDirectories ?? [])].map((d) => resolve(d)),
      integrations: o.integrations,
      approveAll: o.approveAll,
      delegate: o.delegate,
    });
    this.log = o.log ?? ((l) => console.error(l));
  }

  private async open() {
    const inbox = new Inbox();
    await this.o.claude.requireSignIn();
    const session = await this.o.integrations?.session();
    const lease = this.o.hostServers?.();
    const append =
      HOST_INSTRUCTIONS +
      (lease?.instructions ? `\n\n${lease.instructions}` : "") +
      (this.o.persona ? `\n\n${this.o.persona}` : "") +
      memorySections(this.o.memory);
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
          mcpServers: {
            host: createHostMcpServer({
              delegate: this.o.delegate,
              memory: this.o.memory,
              onMemory: this.o.onMemory,
              log: this.log,
            }),
          },
          ...launch.options,
          model: this.model,
          env: { ...this.o.claude.env(), ...(await this.o.env?.()) },
          stderr: (d) => this.log(`[cli stderr] ${d.trimEnd()}`),
        },
      });
      try {
        await q.initializationResult();
      } catch (e) {
        q.close();
        throw e;
      }
      await q.applyFlagSettings({ effortLevel: this.effort });
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
