import { expect, test } from "bun:test";
import type { Integration, IntegrationTool } from "../events.ts";
import { health, listSections, needsAttention, toolGroups } from "./model.ts";

const tool = (name: string, kind: Partial<Pick<IntegrationTool, "readOnly" | "destructive">> = {}): IntegrationTool => ({
  name, description: "", readOnly: false, destructive: false, policy: "ask", lastSeen: 0, ...kind,
});

const integration = (label: string, over: Partial<Integration> = {}): Integration => ({
  id: label, catalogId: label.toLowerCase(), catalog: null, label, name: label.toLowerCase(), transport: { type: "http", url: "https://x.test/mcp" }, auth: { kind: "none" },
  redirectUrl: "", enabled: true, state: "disconnected", error: null, tools: [], skills: [], createdAt: 0, updatedAt: 0, ...over,
});

test("set-up integrations list broken ones first, the same ones the sidebar badge counts", () => {
  const all = [
    integration("Alpha", { state: "connected" }),
    integration("Beta", { state: "failed" }),
    integration("Gamma", { state: "needs-auth", enabled: false }),
    integration("Delta", { state: "needs-auth" }),
    integration("Zeta"),
    integration("Custom", { catalogId: null }),
  ];
  const { yours, available } = listSections(all, "");
  expect(yours.map((e) => e.integration.label)).toEqual(["Beta", "Delta", "Alpha", "Custom", "Gamma"]);
  expect(yours.filter((e) => needsAttention(e.integration)).map((e) => e.integration.label)).toEqual(["Beta", "Delta"]);
  expect(available.map((e) => e.integration.label)).toEqual(["Zeta"]);
});

test("search matches names, then tool names, then skill names, and says which matched", () => {
  const all = [
    integration("Linear", { state: "connected", tools: [tool("list_issues")] }),
    integration("Cloudflare", { state: "connected", skills: [{ name: "wrangler-issues", description: "", enabled: true }] }),
    integration("Issues"),
  ];
  const { yours, available } = listSections(all, " ISSUES ");
  expect(yours.map((e) => [e.integration.label, e.hit])).toEqual([
    ["Cloudflare", { kind: "skill", name: "wrangler-issues" }],
    ["Linear", { kind: "tool", name: "list_issues" }],
  ]);
  expect(available.map((e) => [e.integration.label, e.hit])).toEqual([["Issues", null]]);
});

test("pausing hides a healthy connection but never a broken one", () => {
  expect(health(integration("A", { state: "connected", enabled: false }))).toBe("paused");
  expect(health(integration("A", { state: "failed", enabled: false }))).toBe("failed");
  expect(health(integration("A", { state: "needs-auth", enabled: false }))).toBe("needs-auth");
});

test("tools group as read, write, destructive, and empty groups drop out", () => {
  const tools = [tool("delete_issue", { destructive: true }), tool("get_issue", { readOnly: true }), tool("create_issue")];
  expect(toolGroups(tools, "").map((g) => [g.kind, g.tools.map((t) => t.name)])).toEqual([
    ["read", ["get_issue"]],
    ["write", ["create_issue"]],
    ["destructive", ["delete_issue"]],
  ]);
  expect(toolGroups(tools, "delete").map((g) => g.kind)).toEqual(["destructive"]);
});
