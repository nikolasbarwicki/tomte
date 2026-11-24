// The demo bots' scripts for the fake Claude CLI's `loop.json` (see the header of packages/host/src/testing/fake-claude.ts for the steps):
// background tasks for the background-tasks bot, a reply for the hero animation and the routine runs. A message takes the first unused script
// whose `match` it contains, so the matches are distinctive and each script runs once.
// What the fake CLI does per message: the replies, the background tasks and the routine runs.
const usage = { input_tokens: 1, output_tokens: 1 };
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  emit: {
    type: "assistant",
    message: {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      model: "fake",
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: "tool_use",
      usage,
    },
    parent_tool_use_id: null,
  },
});
const agentCall = (agent: string, description: string) => ({
  subagent_type: agent,
  description,
  prompt: `Do this: ${description}`,
  run_in_background: true,
});
const progress = (taskId: string, description: string, summary: string) => ({
  emit: {
    type: "system",
    subtype: "task_progress",
    task_id: taskId,
    description,
    summary,
    usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
  },
});
/** The front starts a background agent and its turn ends; `after` is what the agent does next. */
const startsAgent = (
  match: string,
  agent: string,
  id: string,
  taskId: string,
  description: string,
  reply: string,
  after: Record<string, unknown>[],
) => ({
  match,
  steps: [
    { text: reply },
    toolUse(id, "Agent", agentCall(agent, description)),
    {
      hook: "PreToolUse",
      tool_use_id: id,
      input: { tool_name: "Agent", tool_input: agentCall(agent, description), tool_use_id: id },
    },
    {
      emit: {
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        tool_use_id: id,
        description,
        subagent_type: agent,
      },
    },
    { result: reply },
    ...after,
  ],
});
const finding = (taskId: string, args: Record<string, string>) => [
  {
    hook: "PreToolUse",
    tool_use_id: `tu-${taskId}`,
    input: {
      tool_name: "mcp__loop__record_progress",
      tool_input: args,
      tool_use_id: `tu-${taskId}`,
      agent_id: taskId,
    },
  },
  { mcp: { server: "loop", tool: "record_progress", args } },
];
export const REPORT =
  "Pgvector is enough up to about 5M rows; past that, Qdrant has the better latency.";
const reply = (match: string, text: string) => ({
  match,
  steps: [{ text }, { result: text }],
});

export const DEMO_SCRIPTS = [
  startsAgent(
    "vector databases",
    "researcher",
    "tu-vec",
    "agent-1",
    "Compare three vector databases",
    "On it. I'll compare them and report back.",
    [
      progress("agent-1", "Compare three vector databases", "Benchmarking query latency"),
      ...finding("agent-1", {
        phase: "Latency",
        finding: "Qdrant answers in 12 ms at 5M rows; pgvector needs 41 ms.",
        next: "Check the cost of each.",
      }),
      { waitFor: "never" },
    ],
  ),
  startsAgent(
    "pricing page",
    "researcher",
    "tu-price",
    "agent-2",
    "Summarize the pricing page changes",
    "Looking at the pricing page now.",
    [
      progress("agent-2", "Summarize the pricing page changes", "Reading the changelog"),
      { waitFor: "never" },
    ],
  ),
  startsAgent(
    "pgvector",
    "researcher",
    "tu-pg",
    "agent-3",
    "Is pgvector enough at our size?",
    "Checking pgvector against our numbers.",
    [
      { sleep: 200 },
      {
        hook: "SubagentStop",
        input: {
          agent_id: "agent-3",
          agent_type: "researcher",
          agent_transcript_path: "",
          stop_hook_active: false,
          last_assistant_message: REPORT,
        },
      },
      {
        emit: {
          type: "system",
          subtype: "task_notification",
          task_id: "agent-3",
          status: "completed",
          output_file: "",
          summary: "done",
        },
      },
    ],
  ),
  // The hero animation: Inbox answers one message.
  reply(
    "what needs me today",
    "Three things need you today:\n\n1. **Invoice from Lumen**, due Friday. I drafted a reply.\n2. **Dana** asked to move Thursday's call.\n3. **The Q3 budget** needs your sign-off.\n\nWant me to send the drafts?",
  ),
  // Routine runs (a scheduled run is a fresh session; the instruction is the match).
  reply("Check last night's deploys", "All 4 deploys went green. No rollbacks."),
  reply("Check last night's deploys", "3 of 4 deploys green; billing-api was rolled back."),
  reply("Check last night's deploys", "All 3 deploys went green. No rollbacks."),
];
