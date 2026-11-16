import { expect, test } from "bun:test";

import { workState, withoutWorkState, type WorkTask } from "./work-state.ts";

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
