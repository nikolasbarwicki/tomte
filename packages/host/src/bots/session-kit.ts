import { isAbsolute, relative, resolve } from "node:path";

import {
  createSdkMcpServer,
  tool,
  type CanUseTool,
  type PermissionResult,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { MemoryScope } from "@claudebot/contract/events";
import { z } from "zod";

import { VERSION } from "../harness/index.ts";
import type { IntegrationsSource } from "../integrations/index.ts";
import { appendMemory, readMemory, writeMemory, type MemoryPaths } from "./memory.ts";

/** Decisions the host (its UI/user) owns. */
export interface HostDelegate {
  /**
   * `eventId` is the external event the bot says the question is about; the host decides whether to believe it. `toolUseId` is
   * the tool use that asked, when the CLI says which, so a session running several agents can tell who is asking.
   */
  askUser(
    question: string,
    options?: string[],
    eventId?: string,
    toolUseId?: string,
  ): Promise<string>;
  /** Bash, or file writes outside the thread's roots. */
  approve(
    toolName: string,
    input: Record<string, unknown>,
    reason: string,
  ): Promise<PermissionResult>;
}

/** The CLI passes the id of the tool use that called an in-process MCP tool in the call's metadata. */
export function toolUseIdOf(extra: unknown): string | undefined {
  const id = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.[
    "claudecode/toolUseId"
  ];
  return typeof id === "string" ? id : undefined;
}

export const ASK_INSTRUCTIONS = [
  "You are embedded in a local host application.",
  "When you need a decision or information from the user, call the mcp__host__ask_user tool instead of guessing.",
  "When you ask because of an external event delivered to you (an <<<EXTERNAL_EVENT ... id=ID ...>>> message), pass that ID as event_id so the user's answer closes the event.",
].join("\n");

export const MEMORY_INSTRUCTIONS = [
  "## Memory",
  "Two memory files are loaded into this prompt whenever the session opens:",
  '- user memory (scope "user"): shared by every bot. Durable facts about the user: who they are, their background, environment, and general preferences that apply to any task.',
  '- bot memory (scope "bot"): only this bot. How this bot should operate: directions, workflow, rules, output format, tone, priorities and boundaries for its job.',
  'When the user tells you how to do your work (do/don\'t, always/never, format, process, style, which tools or sources to use), save it right away with mcp__host__remember scope "bot"; do not ask first. When they reveal a durable fact or general preference about themselves, save it with scope "user". If unsure whether a preference is general or specific to this bot\'s job, use "bot".',
  "Write each entry as one concise, self-contained line. Do not save one-off task details or anything already in memory. When a direction changes or contradicts an existing entry, call mcp__host__rewrite_memory with the complete corrected file for that scope instead of appending.",
  "Mention briefly what you saved.",
].join("\n");

/** The memory files as prompt sections, empty ones left out. */
export function memorySections(memory: MemoryPaths): string {
  const section = (title: string, path: string) => {
    const text = readMemory(path).trim();
    return text ? `\n\n# ${title}\n${text}` : "";
  };
  return (
    section("User memory (about the user)", memory.user) +
    section("Bot memory (how you operate)", memory.bot)
  );
}

/** Push-based async iterable feeding messages into one live query. */
export class Inbox implements AsyncIterable<SDKUserMessage> {
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

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Claudebot's permission rules for one session: host tools run freely, integration tools follow their setting, and files outside the session's roots and shell commands need the user. */
export function createCanUseTool(o: {
  cwd: string;
  roots: string[];
  integrations?: IntegrationsSource | undefined;
  approveAll?: boolean | undefined;
  delegate: HostDelegate;
}): CanUseTool {
  const inRoots = (p: unknown): boolean => {
    if (typeof p !== "string") return false;
    const abs = resolve(o.cwd, p);
    return o.roots.some((r) => {
      const rel = relative(r, abs);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  };
  return async (name, input) => {
    if (
      name.startsWith("mcp__host__") ||
      name.startsWith("mcp__browser__") ||
      name.startsWith("mcp__bots__")
    )
      return { behavior: "allow", updatedInput: input };
    switch (o.integrations?.decide(name)) {
      case "allow":
        return { behavior: "allow", updatedInput: input };
      case "deny":
        return { behavior: "deny", message: "this tool is switched off in Integrations" };
      case "ask":
        return o.delegate.approve(name, input, "integration tool");
    }
    if (o.approveAll) return { behavior: "allow", updatedInput: input };
    const path = input.file_path ?? input.notebook_path ?? input.path;
    if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
      if (path === undefined || inRoots(path)) return { behavior: "allow", updatedInput: input };
      const shown = typeof path === "string" ? path : JSON.stringify(path);
      if (READ_TOOLS.has(name))
        return o.delegate.approve(name, input, `read outside workspace: ${shown}`);
      return o.delegate.approve(name, input, `write outside workspace: ${shown}`);
    }
    if (name === "Bash") return o.delegate.approve(name, input, "shell command");
    return o.delegate.approve(name, input, "tool requires approval");
  };
}

/** The in-process `host` MCP server: `remember` and `rewrite_memory`, and `ask_user` when `delegate` is given. */
export function createHostMcpServer(o: {
  /** Absent for a session that must never block on the user, which therefore has no `ask_user`. */
  delegate?: HostDelegate | undefined;
  memory: MemoryPaths;
  onMemory?: ((scope: MemoryScope, text: string) => void) | undefined;
  log: (line: string) => void;
}) {
  const { delegate, memory, onMemory, log } = o;
  const scope = z
    .enum(["user", "bot"])
    .describe('"user": about the user, shared by all bots; "bot": how this bot should operate');
  const askUser = delegate
    ? [
        tool(
          "ask_user",
          "Ask the human user a question and wait for their answer. The user can always answer in free text; options adds up to 6 suggested answers they can pick with one click.",
          {
            question: z.string(),
            options: z
              .array(z.string().min(1))
              .max(6)
              .optional()
              .describe("Suggested answers, shown as buttons; a click answers with the label"),
            event_id: z
              .string()
              .optional()
              .describe(
                "The id of the external event this question is about, from its <<<EXTERNAL_EVENT>>> header; answering then closes that event",
              ),
          },
          async ({ question, options, event_id }, extra) => {
            log(`[host] ask_user invoked in-process: ${JSON.stringify(question)}`);
            const answer = await delegate.askUser(question, options, event_id, toolUseIdOf(extra));
            return { content: [{ type: "text" as const, text: answer }] };
          },
        ),
      ]
    : [];
  return createSdkMcpServer({
    name: "host",
    version: VERSION,
    tools: [
      ...askUser,
      tool(
        "remember",
        "Append one line to user or bot memory.",
        { scope, line: z.string() },
        async ({ scope, line }) => {
          appendMemory(memory[scope], line);
          onMemory?.(scope, readMemory(memory[scope]));
          return { content: [{ type: "text" as const, text: `saved to ${scope} memory` }] };
        },
      ),
      tool(
        "rewrite_memory",
        "Replace the whole user or bot memory file, to revise or drop entries. Pass the complete new content, one entry per line.",
        { scope, text: z.string() },
        async ({ scope, text }) => {
          writeMemory(memory[scope], text);
          onMemory?.(scope, readMemory(memory[scope]));
          return { content: [{ type: "text" as const, text: `${scope} memory rewritten` }] };
        },
      ),
    ],
  });
}
