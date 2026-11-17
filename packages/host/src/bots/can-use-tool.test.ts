import { describe, expect, test } from "bun:test";

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

import { createCanUseTool, type HostDelegate } from "./session-kit.ts";

const asked: string[] = [];
const delegate: HostDelegate = {
  askUser: () => Promise.reject(new Error("not asked")),
  approve: async (name) => {
    asked.push(name);
    return { behavior: "deny", message: "asked" };
  },
};

const decide = (name: string) =>
  createCanUseTool({ cwd: "/work", roots: ["/work"], delegate })(name, {}, {
    signal: new AbortController().signal,
    toolUseID: "tu",
    requestId: "r",
  } satisfies Parameters<CanUseTool>[2]);

describe("host servers", () => {
  test.each([
    "mcp__host__remember",
    "mcp__browser__browser_open",
    "mcp__bots__list_bots",
    "mcp__routines__list_routines",
  ])("%s runs without an approval card", async (name) => {
    expect(await decide(name)).toMatchObject({ behavior: "allow" });
    expect(asked).toEqual([]);
  });
});

describe("create_bot", () => {
  const opts = {
    signal: new AbortController().signal,
    toolUseID: "tu",
    requestId: "r",
  } satisfies Parameters<CanUseTool>[2];
  const TOOL = "mcp__bots__create_bot";
  const decideWith = (o: { approveAll?: boolean; allows?: boolean; attended?: boolean }) => {
    const answers: string[] = [];
    const canUse = createCanUseTool({
      cwd: "/work",
      roots: ["/work"],
      approveAll: o.approveAll,
      allows: () => o.allows ?? false,
      delegate: {
        askUser: () => Promise.reject(new Error("not asked")),
        approve: async (name, _input, reason) => {
          answers.push(`${name}: ${reason}`);
          return { behavior: "deny", message: "asked" };
        },
        ...(o.attended !== undefined && { attended: () => o.attended! }),
      },
    });
    return { answers, decide: () => canUse(TOOL, { name: "Invoices" }, opts) };
  };

  test("asks on every call, whatever the host's approval setting or an always-allow rule says", async () => {
    const { answers, decide } = decideWith({ approveAll: true, allows: true });
    expect(await decide()).toMatchObject({ behavior: "deny", message: "asked" });
    expect(answers).toEqual([`${TOOL}: creates a bot`]);
  });

  test("is refused where nobody watches, with no approval asked", async () => {
    const { answers, decide } = decideWith({ attended: false });
    expect(await decide()).toMatchObject({
      behavior: "deny",
      message: "scheduled runs cannot create bots; ask the user in chat",
    });
    expect(answers).toEqual([]);
  });
});
