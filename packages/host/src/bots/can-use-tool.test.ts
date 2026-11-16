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
