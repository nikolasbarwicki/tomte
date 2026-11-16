import { expect, test } from "bun:test";

import { restartNotice, workState, withoutWorkState, type WorkTask } from "./work-state.ts";

const task = (over: Partial<WorkTask> & Pick<WorkTask, "taskId" | "goal">): WorkTask => ({
  since: 0,
  status: "running",
  ...over,
});

test("with no tasks every section says none", () => {
  expect(workState(undefined, 3, 0)).toBe(
    [
      "<work_state>",
      "running (0 of 3 slots): (none)",
      "queued: (none)",
      "recent (last 3 ended): (none)",
      "</work_state>",
    ].join("\n"),
  );
});

test("running, queued and ended tasks are listed with their ids, and only the last three ended ones", () => {
  const text = workState(
    {
      running: [
        task({
          taskId: "t1",
          agentType: "researcher",
          model: "sonnet",
          effort: "medium",
          since: 1_000,
          goal: "compare\n  the   plans",
        }),
        task({ taskId: "t2", since: 0, status: "interrupted", goal: "old" }),
      ],
      queued: [
        task({ taskId: "q-1", agentType: "worker", after: "t1", goal: "write it up" }),
        task({ taskId: "q-2", goal: "later" }),
      ],
      ended: ["a", "b", "c", "d"].map((id) => task({ taskId: id, status: "done", goal: id })),
    },
    3,
    66_000,
  );
  expect(text).toBe(
    [
      "<work_state>",
      "running (2 of 3 slots):",
      '  - id t1 researcher sonnet/medium, 1m05s: "compare the plans"',
      '  - id t2 agent ?/?, 1m06s: "old"',
      "    interrupted by an app restart, not resumed yet",
      "queued:",
      '  - id q-1 worker, after t1: "write it up"',
      '  - id q-2 agent, when a slot frees: "later"',
      "recent (last 3 ended):",
      '  - id b, done, "b"',
      '  - id c, done, "c"',
      '  - id d, done, "d"',
      "</work_state>",
    ].join("\n"),
  );
});

test("a running task lists its status line, its newest eight findings and the instructions it was sent", () => {
  const findings = Array.from({ length: 10 }, (_, i) => `fact ${i + 1}`);
  const text = workState(
    {
      running: [
        task({ taskId: "t1", since: 0, goal: "g", line: "Reading the docs", findings, steers: 2 }),
        task({ taskId: "t2", since: 0, goal: "h", findings: [], steers: 0 }),
        task({ taskId: "t3", since: 0, goal: "i" }),
      ],
      queued: [],
      ended: [],
    },
    3,
    5_000,
  );
  expect(text).toBe(
    [
      "<work_state>",
      "running (3 of 3 slots):",
      '  - id t1 agent ?/?, 5s: "g"',
      '    status: "Reading the docs"',
      "    findings (newest last, max 8):",
      ...findings.slice(2).map((f) => `      - ${f}`),
      "    instructions sent so far: 2",
      '  - id t2 agent ?/?, 5s: "h"',
      "    findings: (none yet)",
      '  - id t3 agent ?/?, 5s: "i"',
      "queued: (none)",
      "recent (last 3 ended): (none)",
      "</work_state>",
    ].join("\n"),
  );
});

test("the block the app appends is stripped from a message, and only that block", () => {
  const typed = "what is the plan?\n\nplease be brief";
  expect(withoutWorkState(`${typed}\n\n${workState(undefined, 3, 0)}`)).toBe(typed);
  expect(withoutWorkState(typed)).toBe(typed);
  // A block the user typed in the middle of their message is theirs; only a trailing one is the app's.
  const quoted = "see <work_state>\nx\n</work_state> above";
  expect(withoutWorkState(quoted)).toBe(quoted);
});

test("an earlier block in the user's own text stays when the app's block follows it", () => {
  const typed = "this block:\n\n<work_state>\nmine\n</work_state>\n\nis what I typed";
  expect(withoutWorkState(`${typed}\n\n${workState(undefined, 3, 0)}`)).toBe(typed);
});

test("the restart notice lists each interrupted task with its id and goal and says how to resume it", () => {
  expect(
    restartNotice([
      { taskId: "agent-1", goal: "research ALPHA" },
      { taskId: "agent-2", goal: "research BETA" },
    ]),
  ).toBe(
    "The app restarted. These agents were interrupted:\n- id agent-1: research ALPHA\n- id agent-2: research BETA\nResume each with SendMessage to its id, telling it to continue where it stopped.",
  );
});
