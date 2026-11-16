import { describe, expect, test } from "bun:test";

import { ProgressAttribution, agentDefinitions } from "./agents.ts";

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

describe("agentDefinitions", () => {
  test("the researcher runs in the background on the given model and effort, with web research and its recorder only", () => {
    const { researcher } = agentDefinitions({ model: "opus", effort: "high" });

    expect(researcher).toMatchObject({
      background: true,
      model: "opus",
      effort: "high",
      tools: ["WebSearch", "WebFetch", "mcp__loop__record_progress"],
    });
    expect(researcher?.prompt).toContain("record_progress");
  });
});
