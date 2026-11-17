import { describe, expect, test } from "bun:test";

import { toolView } from "./tool-view.ts";

const call = (name: string, input: unknown) =>
  toolView({
    kind: "tool",
    name,
    input: typeof input === "string" ? input : JSON.stringify(input),
  });

describe("toolView", () => {
  test("names a built-in tool's action and target", () => {
    const v = call("WebFetch", { url: "https://www.example.com/a%20b/c?q=1" });
    expect([v.done, v.doing, v.target]).toEqual(["Read", "Reading", "example.com/a b/c"]);
    expect(call("Read", { file_path: "/x/y/notes.md" }).target).toBe("notes.md");
  });

  test("a command is described by its description when it has one", () => {
    expect(call("Bash", { command: "ls -la", description: "List files" }).done).toBe("List files");
    expect(call("Bash", { command: "ls -la" })).toMatchObject({ done: "Ran", target: "ls -la" });
  });

  test("an MCP tool is told apart from its server, which may contain underscores", () => {
    expect(call("mcp__browser__browser_open", { url: "https://a.test/" })).toMatchObject({
      done: "Opened",
      target: "a.test",
    });
    expect(call("mcp__my_server__do_thing", { id: "7" })).toMatchObject({
      done: "Do thing",
      target: "7",
    });
  });

  test("each known tool says what it did", () => {
    const done = (name: string, input: unknown = {}) => call(name, input).done;
    expect(call("WebSearch", { query: "cafes" })).toMatchObject({ target: "“cafes”" });
    expect(done("Write", { file_path: "/a/b.txt" })).toBe("Edited");
    expect(call("Grep", { pattern: "TODO" })).toMatchObject({
      done: "Searched files for",
      code: true,
    });
    expect(done("mcp__browser__browser_snapshot")).toBe("Looked at the page");
    expect(call("mcp__browser__browser_click", { element: "Save" }).target).toBe("Save");
    expect(done("mcp__browser__browser_request_takeover")).toBe("Request takeover");
    expect(call("mcp__host__remember", { text: "likes tea" })).toMatchObject({
      done: "Remembered",
      target: "likes tea",
    });
    expect(call("mcp__bots__hand_off", { bot: "Ledger" }).target).toBe("Ledger");
    expect(done("mcp__routines__list_routines")).toBe("List routines");
  });

  test("an unknown tool shows its own name and first argument", () => {
    expect(call("Custom", { a: "1" })).toMatchObject({ done: "Custom", target: "1" });
  });

  test("input that is not a JSON object still renders", () => {
    expect(call("Whatever", "not json")).toMatchObject({ done: "Whatever", args: [] });
    expect(call("Whatever", "[1,2]").args).toEqual([]);
  });
});
