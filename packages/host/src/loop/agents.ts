import { isDeepStrictEqual } from "node:util";

import {
  createSdkMcpServer,
  tool,
  type AgentDefinition,
  type EffortLevel,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { toolUseIdOf } from "../bots/index.ts";
import type { Progress } from "./store.ts";
import type { QueueResult } from "./tasks.ts";

export const LOOP_SERVER = "loop";
export const RECORD_PROGRESS = `mcp__${LOOP_SERVER}__record_progress`;
export const QUEUE_TASK = `mcp__${LOOP_SERVER}__queue_task`;
export const CANCEL_QUEUED = `mcp__${LOOP_SERVER}__cancel_queued`;
export const ASK_USER = "mcp__host__ask_user";
const REMEMBER = "mcp__host__remember";
const REWRITE_MEMORY = "mcp__host__rewrite_memory";

/** The agent types the front can start or queue. */
const AGENT_TYPES = ["researcher", "worker"] as const;

/** Turns an agent may take before Claude Code stops it. */
const RESEARCHER_MAX_TURNS = 60;
const WORKER_MAX_TURNS = 80;

const PROGRESS_RULES = `The user follows your work only through record_progress. Call it when your phase changes or you learn something concrete, in the same turn as your next tool calls, never as a step on its own.
"finding" must be a specific fact you verified (or null); "next" is what you will do now.

Messages that arrive while you work come from the person who launched you. Treat each as a course correction and follow the latest one; if you had already stopped, continue where you stopped.`;

/** The final reply is posted in the chat as the bot's own message, so it is written as one. */
const RESULT_RULES = `Your final reply is posted to the user as a chat message, unedited, so write it as the message itself, in the first person.
- Open with one or two plain sentences that give the answer: what you found, stated as the main conclusion ("The pricing comparison is done: both start at $20 a month."). Never open with a caveat or with how you worked.
- Then the substance, compact: a table when comparing things, otherwise short paragraphs or a few bullets. Put source links inline next to the facts they back.
- Then anything you noticed that the goal did not ask about but the user would want to know, in a sentence or two ("One thing I noticed: …"). If the findings point to a choice, say which option you would take and why ("I'd pick X, because Y").
- Close with what you could not verify or what is not published, if anything.
- No title, no headings, no account of your process, no offer of further help. Keep it to what fits comfortably in a chat; go long only when the goal asks for depth.
That message ends the task.`;

const RESEARCHER_PROMPT = `You are a meticulous research analyst answering the goal you are given with well-sourced facts.
Search the web from several angles and open primary sources. State facts from sources only. Do not ask questions; state assumptions in your final reply.

${PROGRESS_RULES}

${RESULT_RULES}`;

/** The built-in tools of the researcher: what the front pre-approves, because nobody answers a card for web research. */
export const RESEARCH_TOOLS = ["WebSearch", "WebFetch"];

/** The built-in tools of the worker that read and write files, always inside its boundary (`loop/guard.ts`). */
const WORKER_FILE_TOOLS = ["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"];

/** Built-in tools only the front uses; the session's `tools` hold them and the agents' own tools beside them. */
export const FRONT_BUILTIN_TOOLS = ["Agent", "SendMessage", "TaskStop"];

/**
 * Everything the front itself may use (decision 5 of ADR-0011), besides the handoff and routine tools the host's `bots` and `routines` servers add. This is
 * the one list the front's tool set is held to: whatever an agent has and is not here is denied to the front.
 */
const FRONT_TOOLS = [...FRONT_BUILTIN_TOOLS, QUEUE_TASK, CANCEL_QUEUED, REMEMBER, REWRITE_MEMORY];

/** MCP servers the host itself defines; an integration of the same name would shadow one, so it is left out of the session. */
export const HOST_SERVER_NAMES = ["host", "loop", "bots", "browser", "routines"];

/** What the worker is set up with when the front session opens: the bot's shell, its integrations and who it is. */
export interface WorkerSetup {
  /** False when the bot's isolation disables its shell: the worker then has no Bash. */
  shell: boolean;
  /** Names of the integration MCP servers the session connects; the worker has every tool of each. */
  integrationServers: string[];
  /** The bot's persona and memory, which the worker's prompt ends with. */
  context: string;
}

const workerPrompt = ({
  shell,
  context,
}: WorkerSetup) => `You are a careful analyst and engineer doing a hands-on task for the assistant you work for: analysing data, writing and running scripts, producing files, and using the assistant's connected services.
You work in your working directory and in the files folder named below; the file tools refuse every other place, so never try to reach outside them. ${shell ? "Shell commands run in a sandbox, and some may need the user's approval, which you wait for." : "You have no shell here: do the work with the file tools and the connected services."}
Ask the user with ${ASK_USER} only when a wrong guess would cost them something and you cannot go on without the answer; the question waits for their reply while the other tasks continue. Otherwise do not ask: state your assumptions in your final reply.

${PROGRESS_RULES}

${RESULT_RULES}
Name the files you produced.

${context}`;

/** The bot's own model and effort setting, which its background agents run on. */
export interface AgentSettings {
  model: string;
  effort: EffortLevel;
}

/** The agent types the front can start with the Agent tool, running on the bot's model and effort. */
export function agentDefinitions(
  { model, effort }: AgentSettings,
  worker: WorkerSetup,
): Record<string, AgentDefinition> {
  return {
    researcher: {
      description:
        "Web research that ends in a sourced answer, written as a chat message. Use for anything that needs searching and reading sources.",
      prompt: RESEARCHER_PROMPT,
      model,
      effort,
      tools: [...RESEARCH_TOOLS, RECORD_PROGRESS],
      maxTurns: RESEARCHER_MAX_TURNS,
      background: true,
    },
    worker: {
      description: `Hands-on work in the bot's workspace and files folder: analysis, files${worker.shell ? ", scripts run in a sandbox" : ""} and the bot's connected services. No browser. May ask the user a question. Ends in a chat message with the results.`,
      prompt: workerPrompt(worker),
      model,
      effort,
      tools: [
        ...WORKER_FILE_TOOLS,
        ...(worker.shell ? ["Bash"] : []),
        ...worker.integrationServers.map((name) => `mcp__${name}`),
        ASK_USER,
        RECORD_PROGRESS,
      ],
      maxTurns: WORKER_MAX_TURNS,
      background: true,
    },
  };
}

/** Every tool some agent has, as the agent definitions name them: built-in tools, MCP tools and whole MCP servers (`mcp__name`). */
const agentTools = (agents: Record<string, AgentDefinition>) => [
  ...new Set(Object.values(agents).flatMap((a) => a.tools ?? [])),
];

/** The session's built-in tools: the front's and those of every agent, because subagents only see what the session has. */
export const sessionTools = (agents: Record<string, AgentDefinition>) => [
  ...new Set([...FRONT_BUILTIN_TOOLS, ...agentTools(agents).filter((t) => !t.startsWith("mcp__"))]),
];

/**
 * The agent the main thread runs as, so its tool set is the front's and not the session's whole one. It has no tool list of its
 * own to be kept in step with: it is denied every tool an agent has that the front does not, computed from the agent
 * definitions, so a tool added to an agent never reaches the front. What is left is the session's other tools: the front's own
 * (`FRONT_TOOLS`) and the host's handoff and routine tools. Its instructions are the session's system prompt, which wins over an agent's own.
 */
export function frontAgent(agents: Record<string, AgentDefinition>): AgentDefinition {
  return {
    description: "The chat voice itself. Never start it as a task.",
    prompt: "You are the chat voice of the assistant.",
    disallowedTools: agentTools(agents).filter((t) => !FRONT_TOOLS.includes(t)),
  };
}

/**
 * Which agent made a call: `record_progress` and `ask_user` are in-process MCP tools whose handler can't see its caller. The
 * PreToolUse hook notes every such call first and the handler takes the matching note: by tool use id when the CLI passes one,
 * else by identical arguments.
 */
export class ProgressAttribution {
  private readonly pending: { toolUseId: string; agentId: string; input: unknown }[] = [];

  note(toolUseId: string, agentId: string, input: unknown): void {
    this.pending.push({ toolUseId, agentId, input });
    if (this.pending.length > 200) this.pending.shift();
  }

  take(toolUseId: string | undefined, args: unknown): string | undefined {
    let i = toolUseId ? this.pending.findIndex((p) => p.toolUseId === toolUseId) : -1;
    if (i === -1) i = this.pending.findIndex((p) => isDeepStrictEqual(p.input, args));
    return i === -1 ? undefined : this.pending.splice(i, 1)[0]?.agentId;
  }
}

const text = (s: string, isError = false) => ({
  content: [{ type: "text" as const, text: s }],
  isError,
});

/** The in-process `loop` MCP server the front session hosts: `record_progress` for the agents, the queue tools for the front. */
export function createLoopServer(o: {
  attribution: ProgressAttribution;
  /** Stores a finding for the task the call was attributed to. */
  onProgress: (taskId: string, progress: Progress) => void;
  queue: (goal: string, agentType: string, after: string | null) => QueueResult;
  cancelQueued: (id: string) => QueueResult;
}) {
  let last: { taskId: string; progress: Progress } | undefined;
  const recordProgress = tool(
    "record_progress",
    "Record where you are in the task and what you just learned. Shown to the user.",
    {
      phase: z.string().describe("Short name of the current phase, e.g. 'Checking Cursor docs'."),
      finding: z
        .string()
        .nullable()
        .describe("One verified, specific fact learned since the last call, or null."),
      next: z.string().describe("What you will do next."),
    },
    async (args, extra) => {
      const taskId = o.attribution.take(toolUseIdOf(extra), args);
      if (!taskId)
        return text("Not recorded: the call could not be matched to a running task.", true);
      if (last?.taskId === taskId && isDeepStrictEqual(last.progress, args))
        return text("Already recorded. Continue the task.");
      last = { taskId, progress: args };
      o.onProgress(taskId, args);
      return text("Recorded. Continue the task.");
    },
    { annotations: { readOnlyHint: true }, alwaysLoad: true },
  );
  const queueTask = tool(
    "queue_task",
    "Queue a background task to start later: after another task ends, or when a slot frees. The app tells you when to start it.",
    {
      goal: z
        .string()
        .describe("Self-contained goal including scope and the expected shape of the result."),
      agent: z.enum(AGENT_TYPES).describe("Agent type that will run it."),
      after: z
        .string()
        .nullable()
        .describe(
          "Id of the running or queued task to wait for, from <work_state>; null to start as soon as a slot is free.",
        ),
    },
    async (args) => {
      const r = o.queue(args.goal, args.agent, args.after);
      return r.ok ? text(`Queued as ${r.id}.`) : text(r.error, true);
    },
    { alwaysLoad: true },
  );
  const cancelQueued = tool(
    "cancel_queued",
    "Drop a queued task that has not started.",
    { id: z.string().describe("Queued task id (q-…) from <work_state>.") },
    async (args) => {
      const r = o.cancelQueued(args.id);
      return r.ok ? text(`Dropped ${r.id}.`) : text(r.error, true);
    },
    { alwaysLoad: true },
  );
  return createSdkMcpServer({
    name: LOOP_SERVER,
    tools: [recordProgress, queueTask, cancelQueued],
  });
}
