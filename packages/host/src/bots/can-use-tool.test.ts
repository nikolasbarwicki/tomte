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

describe("a locked integration tool", () => {
  const opts = {
    signal: new AbortController().signal,
    toolUseID: "tu",
    requestId: "r",
  } satisfies Parameters<CanUseTool>[2];
  const LOCKED = "mcp__mail__send";
  const decideWith = (o: {
    decision: "allow" | "ask" | "deny";
    approveAll?: boolean;
    allows?: boolean;
    tool?: string;
  }) => {
    const answers: string[] = [];
    const canUse = createCanUseTool({
      cwd: "/work",
      roots: ["/work"],
      approveAll: o.approveAll,
      allows: () => o.allows ?? false,
      integrations: {
        session: () => Promise.reject(new Error("not opened")),
        decide: () => o.decision,
        locked: (name) => name === LOCKED,
        prepareApproval: async (_name, input) => ({ input }),
        reconcile: () => {},
      },
      delegate: {
        askUser: () => Promise.reject(new Error("not asked")),
        approve: async (name, _input, reason) => {
          answers.push(`${name}: ${reason}`);
          return { behavior: "deny", message: "asked" };
        },
      },
    });
    return { answers, decide: () => canUse(o.tool ?? LOCKED, { to: "ana@example.com" }, opts) };
  };

  test("asks though the host approves everything and the bot always allows it", async () => {
    const { answers, decide } = decideWith({ decision: "ask", approveAll: true, allows: true });
    expect(await decide()).toMatchObject({ behavior: "deny", message: "asked" });
    expect(answers).toEqual([`${LOCKED}: integration tool`]);
  });

  test("that is switched off is denied without asking, whatever the bot always allows", async () => {
    const { answers, decide } = decideWith({ decision: "deny", approveAll: true, allows: true });
    expect(await decide()).toMatchObject({ behavior: "deny" });
    expect(answers).toEqual([]);
  });

  test("leaves an integration tool that is not locked to the bot's always-allow rule", async () => {
    const { answers, decide } = decideWith({
      decision: "ask",
      allows: true,
      tool: "mcp__mail__search",
    });
    expect(await decide()).toMatchObject({ behavior: "allow" });
    expect(answers).toEqual([]);
  });
});
