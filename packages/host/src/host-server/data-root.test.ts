import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { COLOR_NAMES, SHAPE_NAMES } from "@tomte/contract/avatars";

import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

let mcp: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  mcp = Bun.serve({
    port: 0,
    async fetch(req) {
      const server = new McpServer({ name: "fixture", version: "1.0.0" });
      server.registerTool(
        "lookup",
        { description: "Look something up", annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(req);
    },
  });
});
afterAll(() => mcp.stop(true));

let host: HandoffHost;
let scratch: string;
const savedConfig = process.env.CLAUDE_CONFIG_DIR;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "data-root-"));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
});
afterEach(async () => {
  await host.stop();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(scratch, { recursive: true, force: true });
});

const post = async <T>(path: string, body: object) =>
  (await (await host.ui(path, body)).json()) as T;

test("a host started on a data root keeps its database, bots, memory and plugins there and writes nothing to the process directory or the workspace", async () => {
  const dataRoot = join(scratch, "state");
  const skills = join(scratch, "skills");
  mkdirSync(join(skills, "alpha"), { recursive: true });
  writeFileSync(
    join(skills, "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: Does alpha\n---\n# alpha\n",
  );
  const processDirBefore = readdirSync(process.cwd()).sort();

  host = await startHandoffHost(["--data-root", dataRoot]);
  expect(host.dataRoot).toBe(dataRoot);

  await post("/api/integrations/add-custom", {
    name: "fx",
    url: `http://127.0.0.1:${mcp.port}/mcp`,
    transport: "http",
    skillsDir: skills,
  });
  const bot = await post<{ id: string }>("/api/bots/new", {
    name: "Ada",
    purpose: "tests",
    shape: SHAPE_NAMES[0],
    color: COLOR_NAMES[0],
  });
  host.rememberOnMessage("user", "Prefers tea over coffee.");
  expect((await host.ui("/api/send", { text: "hello" })).status).toBe(200);
  await host.until(() => existsSync(join(dataRoot, "memory.md")));

  expect(existsSync(join(dataRoot, "tomte.db"))).toBe(true);
  expect(JSON.parse(readFileSync(join(dataRoot, "bots", bot.id, "bot.json"), "utf8")).name).toBe(
    "Ada",
  );
  expect(readFileSync(join(dataRoot, "memory.md"), "utf8")).toContain("Prefers tea over coffee.");
  expect(existsSync(join(dataRoot, "plugins", "fx", ".claude-plugin", "plugin.json"))).toBe(true);

  expect(readdirSync(process.cwd()).sort()).toEqual(processDirBefore);
  expect(readdirSync(host.cwd)).toEqual([]);
});
