import { describe, expect, test } from "bun:test";

import {
  ProgressAttribution,
  agentDefinitions,
  frontAgent,
  sessionTools,
  type WorkerSetup,
} from "./agents.ts";
import { FRONT_PROMPT } from "./prompt.ts";

const finding = { phase: "Pricing", finding: "$20 a month", next: "Check teams" };

describe("ProgressAttribution", () => {
  test("matches a call to its note by tool use id, whatever the arguments", () => {
    const a = new ProgressAttribution();
    a.note("tu-1", "agent-1", finding);
    a.note("tu-2", "agent-2", finding);

    expect(a.take("tu-2", { different: true })).toBe("agent-2");
    expect(a.take("tu-1", finding)).toBe("agent-1");
  });

  test("falls back to identical arguments when the CLI passes no tool use id, oldest note first", () => {
    const a = new ProgressAttribution();
    a.note("tu-1", "agent-1", finding);
    a.note("tu-2", "agent-2", { ...finding, phase: "Other" });
    a.note("tu-3", "agent-3", finding);

    expect(a.take(undefined, { ...finding })).toBe("agent-1");
    expect(a.take(undefined, { ...finding })).toBe("agent-3");
    expect(a.take(undefined, { ...finding })).toBeUndefined();
    expect(a.take("unknown", { ...finding, phase: "Other" })).toBe("agent-2");
  });

  test("a note is taken once", () => {
    const a = new ProgressAttribution();
    a.note("tu-1", "agent-1", finding);
    expect(a.take("tu-1", finding)).toBe("agent-1");
    expect(a.take("tu-1", finding)).toBeUndefined();
  });

  test("keeps the newest 200 notes", () => {
    const a = new ProgressAttribution();
    for (let i = 0; i < 201; i++) a.note(`tu-${i}`, `agent-${i}`, { i });

    expect(a.take("tu-0", { i: 0 })).toBeUndefined();
    expect(a.take("tu-1", { i: 1 })).toBe("agent-1");
    expect(a.take("tu-200", { i: 200 })).toBe("agent-200");
  });
});

const settings = { model: "opus", effort: "high" } as const;
const setup = (over: Partial<WorkerSetup> = {}): WorkerSetup => ({
  shell: true,
  integrationServers: [],
  context: "# This bot\nYou are Dev.",
  ...over,
});

describe("agentDefinitions", () => {
  test("the researcher runs in the background on the given model and effort, with web research and its recorder only", () => {
    const { researcher } = agentDefinitions(settings, setup());

    expect(researcher).toMatchObject({
      background: true,
      model: "opus",
      effort: "high",
      tools: ["WebSearch", "WebFetch", "mcp__loop__record_progress"],
    });
    expect(researcher?.prompt).toContain("record_progress");
    expect(researcher?.prompt).toContain("## Core assistant behavior");
    expect(researcher?.prompt).toContain("never slip back into English");
    expect(researcher?.prompt).toContain("confidence level");
    expect(researcher?.prompt).toContain("did not touch or change");
  });

  test("the worker has the bot's file tools, its shell, its integrations, ask_user and its recorder, and no web or browser tools", () => {
    const { worker } = agentDefinitions(
      settings,
      setup({ integrationServers: ["github", "linear"] }),
    );

    expect(worker).toMatchObject({ background: true, model: "opus", effort: "high", maxTurns: 80 });
    expect(worker?.tools).toEqual([
      "Read",
      "Write",
      "Edit",
      "NotebookEdit",
      "Glob",
      "Grep",
      "Bash",
      "mcp__github",
      "mcp__linear",
      "mcp__host__ask_user",
      "mcp__loop__record_progress",
    ]);
    expect(worker?.tools?.some((t) => /^(Web|mcp__(browser|bots))/.test(t))).toBe(false);
  });

  test("a bot whose shell is disabled has a worker without Bash that is not told it has a shell", () => {
    const { worker } = agentDefinitions(settings, setup({ shell: false }));

    expect(worker?.tools).not.toContain("Bash");
    expect(worker?.prompt).toContain("You have no shell");
    expect(worker?.description).not.toContain("scripts");
  });

  test("the worker's prompt carries the progress and result rules and ends with the bot's persona and memory", () => {
    const { worker } = agentDefinitions(settings, setup());

    expect(worker?.prompt).toContain("record_progress");
    expect(worker?.prompt).toContain("posted to the user as a chat message");
    expect(worker?.prompt).toContain("never slip back into English");
    expect(worker?.prompt).toContain("confidence level");
    expect(worker?.prompt).toContain("did not touch or change");
    expect(worker?.prompt).toContain("irreversible or externally visible action");
    expect(worker?.prompt.endsWith("# This bot\nYou are Dev.")).toBe(true);
  });

  test("FRONT_PROMPT carries active-language instructions for background tasks and avoids duplicating core behavior", () => {
    expect(FRONT_PROMPT).toContain("language other than English");
    expect(FRONT_PROMPT).toContain("including the user's language in the goal when non-English");
    expect(FRONT_PROMPT).not.toContain("## Core assistant behavior");
  });
});

/** What the CLI leaves of a tool pool once an agent's `disallowedTools` apply: an exact name, or a whole MCP server (`mcp__server`, `mcp__server__*`). */
const effective = (pool: string[], disallowed: string[] = []) =>
  pool.filter(
    (t) =>
      !disallowed.some((d) => {
        const server = d.replace(/__\*$/, "");
        return t === d || (server.split("__").length === 2 && t.startsWith(`${server}__`));
      }),
  );

/** The tools the session's own servers offer, as the CLI names them: the host's, the loop's and the handoff server's. */
const SERVER_TOOLS = [
  "mcp__host__ask_user",
  "mcp__host__remember",
  "mcp__host__rewrite_memory",
  "mcp__loop__record_progress",
  "mcp__loop__queue_task",
  "mcp__loop__cancel_queued",
  "mcp__bots__send_task",
  "mcp__bots__list_bots",
];
const INTEGRATION_TOOLS = ["mcp__github__create_issue", "mcp__github__search"];

describe("the front's tool set", () => {
  const front = (shell: boolean, integrationServers: string[]) => {
    const agents = agentDefinitions(settings, setup({ shell, integrationServers }));
    const pool = [
      ...sessionTools(agents),
      ...SERVER_TOOLS,
      ...(integrationServers.includes("github") ? INTEGRATION_TOOLS : []),
    ];
    return effective(pool, frontAgent(agents).disallowedTools).sort();
  };

  test("is the front's own tools and the handoff tools, whatever the worker has", () => {
    const own = [
      "Agent",
      "SendMessage",
      "TaskStop",
      "mcp__bots__list_bots",
      "mcp__bots__send_task",
      "mcp__host__remember",
      "mcp__host__rewrite_memory",
      "mcp__loop__cancel_queued",
      "mcp__loop__queue_task",
    ];

    expect(front(true, ["github"])).toEqual(own);
    expect(front(false, ["github"])).toEqual(own);
    expect(front(true, [])).toEqual(own);
  });

  test("the session holds the front's built-in tools and every agent's, so subagents have them", () => {
    const agents = agentDefinitions(settings, setup({ integrationServers: ["github"] }));

    expect(sessionTools(agents)).toEqual([
      "Agent",
      "SendMessage",
      "TaskStop",
      "WebSearch",
      "WebFetch",
      "Read",
      "Write",
      "Edit",
      "NotebookEdit",
      "Glob",
      "Grep",
      "Bash",
    ]);
    expect(sessionTools(agentDefinitions(settings, setup({ shell: false })))).not.toContain("Bash");
  });

  test("a tool added to an agent never reaches the front, and one the front owns stays", () => {
    const agents = agentDefinitions(settings, setup());
    const worker = agents.worker!;
    agents.worker = {
      ...worker,
      tools: [
        ...(worker.tools ?? []),
        "WebFetch",
        "Skill",
        "mcp__new__thing",
        "mcp__loop__queue_task",
      ],
    };
    const pool = [...sessionTools(agents), "Skill", "mcp__new__thing", ...SERVER_TOOLS];
    const left = effective(pool, frontAgent(agents).disallowedTools);

    expect(left).not.toContain("Skill");
    expect(left).not.toContain("mcp__new__thing");
    expect(left).not.toContain("WebFetch");
    expect(left).toContain("mcp__loop__queue_task");
  });
});
