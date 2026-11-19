import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { migrate } from "../platform/db.ts";
import { InvalidInput } from "../platform/errors.ts";
import { memorySecrets } from "../platform/secrets.ts";
import { oauthFixture } from "../testing/fake-oauth-server.ts";
import { CATALOG, type CatalogEntry } from "./catalog.ts";
import {
  NameTaken,
  createIntegrations,
  withOfflineAccess,
  type Integrations,
  type ServerName,
} from "./index.ts";
import * as store from "./store.ts";

let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
      mcp.registerTool(
        "lookup",
        { description: "Look something up", annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
      mcp.registerTool(
        "delete_all",
        { description: "Delete everything", annotations: { destructiveHint: true } },
        async () => ({ content: [{ type: "text", text: "gone" }] }),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      return transport.handleRequest(req);
    },
  });
  url = `http://127.0.0.1:${server.port}/mcp`;
});
afterAll(() => server.stop(true));

let integrations: Integrations;
let secrets: ReturnType<typeof memorySecrets>;
let changes: number;
let clock = 1_000;
const REDIRECT = "http://127.0.0.1:9/oauth/callback";
const SHOWN = {
  category: "Engineering" as const,
  tagline: "Test service",
  icon: { color: "#000000", path: "M0 0h24v24H0z" },
  examples: [],
};
let hostDir: string;

beforeEach(() => {
  hostDir = mkdtempSync(join(tmpdir(), "tomte-host-"));
  secrets = memorySecrets();
  changes = 0;
  clock = 1_000;
  integrations = createIntegrations({
    db: migrate(new Database(":memory:")),
    secrets,
    hostDir,
    now: () => clock,
    onChange: () => changes++,
    oauthRedirectUrl: REDIRECT,
  });
});

const rows = (db: Database) =>
  (db.query("SELECT count(*) AS n FROM integrations").get() as { n: number }).n;
const add = (name = "fx") => integrations.addCustom({ name, url, transport: "http" });
const policies = async (name = "fx") =>
  Object.fromEntries((await add(name)).tools.map((t) => [t.name, t.policy]));

test("a new tool defaults to Auto when read-only and Ask otherwise", async () => {
  const i = await add();
  expect(i.state).toBe("connected");
  expect(
    Object.fromEntries(i.tools.map((t) => [t.name, [t.readOnly, t.destructive, t.policy]])),
  ).toEqual({
    lookup: [true, false, "auto"],
    delete_all: [false, true, "ask"],
  });
  expect(changes).toBe(1);
});

test("re-probing keeps an existing policy", async () => {
  const { id } = await add();
  integrations.setPolicy(id, "lookup", "off");
  const again = await integrations.probe(id);
  expect(again.tools.find((t) => t.name === "lookup")!.policy).toBe("off");
});

test("session output lists only enabled, connected integrations", async () => {
  const a = await add("fx");
  const b = await add("other");
  expect(Object.keys((await integrations.session()).mcpServers).sort()).toEqual(["fx", "other"]);
  integrations.setEnabled(a.id, false);
  expect(Object.keys((await integrations.session()).mcpServers)).toEqual(["other"]);
  await integrations.remove(b.id);
  expect(Object.keys((await integrations.session()).mcpServers)).toEqual([]);
});

test("an unreachable server is stored as failed and kept out of the session", async () => {
  const i = await integrations.addCustom({
    name: "dead",
    url: "http://127.0.0.1:1/mcp",
    transport: "http",
  });
  expect(i.state).toBe("failed");
  expect(i.error).toBeTruthy();
  expect((await integrations.session()).mcpServers).toEqual({});
});

test("disallowedTools holds exactly the Off tools, named mcp__<server>__<tool>", async () => {
  const { id } = await add();
  expect((await integrations.session()).disallowedTools).toEqual([]);
  integrations.setPolicy(id, "delete_all", "off");
  expect((await integrations.session()).disallowedTools).toEqual(["mcp__fx__delete_all"]);
});

test("a locked tool never reads as Auto and refuses it, though it is read-only", async () => {
  integrations = createIntegrations({
    db: migrate(new Database(":memory:")),
    secrets,
    hostDir,
    now: () => clock,
    onChange: () => changes++,
    oauthRedirectUrl: REDIRECT,
    lockedTools: new Set(["mcp__fx__lookup"]),
  });
  const i = await add();
  const tool = (name: string) =>
    integrations
      .list()
      .find((x) => x.id === i.id)!
      .tools.find((t) => t.name === name)!;
  expect([tool("lookup").locked, tool("lookup").policy]).toEqual([true, "ask"]);
  expect([tool("delete_all").locked, tool("delete_all").policy]).toEqual([false, "ask"]);
  expect(integrations.locked("mcp__fx__lookup")).toBe(true);
  expect(integrations.locked("mcp__fx__delete_all")).toBe(false);
  expect(integrations.decide("mcp__fx__lookup")).toBe("ask");
  expect((await integrations.session()).policyOf("mcp__fx__lookup")).toBe("ask");

  expect(() => integrations.setPolicy(i.id, "lookup", "auto")).toThrow(InvalidInput);
  integrations.setPolicy(i.id, "lookup", "off");
  expect(integrations.decide("mcp__fx__lookup")).toBe("deny");
  integrations.setPolicy(i.id, "lookup", "ask");
  expect(tool("lookup").policy).toBe("ask");
  integrations.resetPolicies(i.id);
  expect(integrations.decide("mcp__fx__lookup")).toBe("ask");

  integrations.setPolicy(i.id, "delete_all", "auto");
  expect(integrations.decide("mcp__fx__delete_all")).toBe("allow");
});

test("tool decisions follow policy, and an unrecorded tool is Ask", async () => {
  const { id } = await add();
  expect(integrations.decide("mcp__fx__lookup")).toBe("allow");
  expect(integrations.decide("mcp__fx__delete_all")).toBe("ask");
  integrations.setPolicy(id, "lookup", "off");
  expect(integrations.decide("mcp__fx__lookup")).toBe("deny");
  integrations.setPolicy(id, "delete_all", "auto");
  expect(integrations.decide("mcp__fx__delete_all")).toBe("allow");
  expect(integrations.decide("mcp__fx__brand_new")).toBe("ask");
  expect(integrations.decide("Bash")).toBeUndefined();
  const s = await integrations.session();
  expect(s.policyOf("mcp__fx__lookup")).toBe("off");
  expect(s.policyOf("mcp__fx__brand_new")).toBe("ask");
});

test("a tool of a removed or disabled integration is denied", async () => {
  const { id } = await add();
  integrations.setEnabled(id, false);
  expect(integrations.decide("mcp__fx__lookup")).toBe("deny");
  await integrations.remove(id);
  expect(integrations.decide("mcp__fx__lookup")).toBe("deny");
});

test("remove forgets the tool policies", async () => {
  const { id } = await add();
  integrations.setPolicy(id, "lookup", "off");
  await integrations.remove(id);
  expect(await policies()).toEqual({ lookup: "auto", delete_all: "ask" });
});

test("empty, malformed names and malformed urls are rejected and save nothing", async () => {
  for (const name of ["", "Bad", "1x", "has-dash", "a".repeat(33)]) {
    await expect(integrations.addCustom({ name, url, transport: "http" })).rejects.toBeInstanceOf(
      InvalidInput,
    );
  }
  for (const bad of ["", "not a url", "ftp://example.com/x"]) {
    await expect(
      integrations.addCustom({ name: "ok", url: bad, transport: "http" }),
    ).rejects.toBeInstanceOf(InvalidInput);
  }
  expect(integrations.list().filter((i) => i.catalogId === null)).toEqual([]);
  expect(changes).toBe(0);
});

test.each(["host", "browser", "bots", "routines", "gmail"])(
  "the name %s is reserved: refused as invalid input and nothing is saved",
  async (name) => {
    await expect(integrations.addCustom({ name, url, transport: "http" })).rejects.toBeInstanceOf(
      InvalidInput,
    );
    await expect(
      integrations.addCustom({ name, transport: "stdio", command: "true" }),
    ).rejects.toBeInstanceOf(InvalidInput);
    expect(integrations.list().filter((i) => i.catalogId === null)).toEqual([]);
    expect(changes).toBe(0);
  },
);

test("a duplicate name is rejected", async () => {
  await add();
  await expect(add()).rejects.toBeInstanceOf(NameTaken);
});

test("listed integrations carry no secret and remove clears the stored secret", async () => {
  const { id } = await add();
  await secrets.set(`integration:${id}`, JSON.stringify({ token: "s3cret" }));
  expect(JSON.stringify(integrations.list())).not.toContain("s3cret");
  await integrations.remove(id);
  expect(await secrets.get(`integration:${id}`)).toBeNull();
});

test("bulk reset follows the read-only annotation and persists", async () => {
  const { id } = await add();
  integrations.setPolicy(id, "lookup", "off");
  integrations.setPolicy(id, "delete_all", "auto");
  integrations.resetPolicies(id);
  expect(
    Object.fromEntries(
      integrations
        .list()
        .find((i) => i.id === id)!
        .tools.map((t) => [t.name, t.policy]),
    ),
  ).toEqual({ lookup: "auto", delete_all: "ask" });
});

test("a disabled integration contributes nothing and keeps its choices when re-enabled", async () => {
  const { id } = await add();
  integrations.setPolicy(id, "delete_all", "off");
  integrations.setEnabled(id, false);
  expect(await integrations.session()).toMatchObject({ mcpServers: {}, disallowedTools: [] });
  integrations.setEnabled(id, true);
  expect((await integrations.session()).disallowedTools).toEqual(["mcp__fx__delete_all"]);
});

const authed = (token: string) =>
  Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${token}`)
        return new Response("bad token", { status: 401 });
      const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
      mcp.registerTool(
        "lookup",
        { description: "x", annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      return transport.handleRequest(req);
    },
  });

test("a fresh workspace lists the whole catalog, grouped data included, without inserting a row", () => {
  const db = migrate(new Database(":memory:"));
  const l = createIntegrations({
    db,
    secrets,
    hostDir,
    onChange: () => {},
    oauthRedirectUrl: REDIRECT,
  }).list();
  expect(l.map((i) => [i.catalogId, i.state])).toEqual(CATALOG.map((c) => [c.id, "disconnected"]));
  expect(l.every((i) => i.catalog?.category)).toBe(true);
  expect(rows(db)).toBe(0);
});

test("connecting a browsed built-in inserts exactly one row under the listed id", async () => {
  const db = migrate(new Database(":memory:"));
  integrations = createIntegrations({
    db,
    secrets,
    hostDir,
    now: () => clock,
    onChange: () => {},
    oauthRedirectUrl: REDIRECT,
    catalog: [{ id: "svc", label: "Svc", url, auth: { kind: "bearer" }, ...SHOWN }],
  });
  const { id } = integrations.list()[0]!;
  await expect(integrations.setBearer(id, " ")).rejects.toBeInstanceOf(InvalidInput);
  expect(rows(db)).toBe(0);
  expect((await integrations.setBearer(id, "t1")).state).toBe("connected");
  await integrations.setBearer(id, "t2");
  await integrations.probe(id);
  expect(rows(db)).toBe(1);
  expect(integrations.list().map((i) => [i.id, i.state])).toEqual([[id, "connected"]]);
});

test("an upgraded database keeps its built-in rows and lists each built-in once", () => {
  const db = migrate(new Database(":memory:"));
  store.insert(db, {
    id: "old-uuid",
    catalogId: "linear",
    name: "linear",
    transport: { type: "http", url: "https://mcp.linear.app/mcp" },
    auth: { kind: "none" },
    enabled: true,
    state: "connected",
    error: null,
    createdAt: 1,
    updatedAt: 1,
  });
  const l = createIntegrations({
    db,
    secrets,
    hostDir,
    onChange: () => {},
    oauthRedirectUrl: REDIRECT,
  }).list();
  expect(rows(db)).toBe(1);
  expect(l.filter((i) => i.catalogId === "linear").map((i) => [i.id, i.state])).toEqual([
    ["old-uuid", "connected"],
  ]);
  expect(l.length).toBe(CATALOG.length);
  expect(l.find((i) => i.id === "old-uuid")!.auth).toEqual(
    CATALOG.find((c) => c.id === "linear")!.auth,
  );
});

test("a bearer token is stored in the secret store, sent as Authorization, and never listed", async () => {
  const s = authed("sekret");
  try {
    const i = await integrations.addCustom({
      name: "priv",
      url: `http://127.0.0.1:${s.port}/mcp`,
      transport: "http",
      token: "sekret",
    });
    expect(i.state).toBe("connected");
    expect([...secrets.entries.values()].join()).toContain("sekret");
    expect(JSON.stringify(integrations.list())).not.toContain("sekret");
    expect((await integrations.session()).mcpServers["priv" as ServerName]).toMatchObject({
      headers: { Authorization: "Bearer sekret" },
    });
  } finally {
    await s.stop(true);
  }
});

test("a rejected token shows failed with the server's error and stores nothing", async () => {
  const s = authed("good");
  try {
    const i = await integrations.addCustom({
      name: "priv",
      url: `http://127.0.0.1:${s.port}/mcp`,
      transport: "http",
      token: "bad",
    });
    expect(i.state).toBe("failed");
    expect(i.error).toBeTruthy();
    expect(secrets.entries.size).toBe(0);
    expect((await integrations.session()).mcpServers).toEqual({});
  } finally {
    await s.stop(true);
  }
});

test("disconnect deletes the secret and keeps policies; reconnecting restores them; remove deletes both", async () => {
  const s = authed("t1");
  try {
    const { id } = await integrations.addCustom({
      name: "priv",
      url: `http://127.0.0.1:${s.port}/mcp`,
      transport: "http",
      token: "t1",
    });
    integrations.setPolicy(id, "lookup", "off");
    await integrations.disconnect(id);
    expect(secrets.entries.size).toBe(0);
    expect(integrations.list().find((i) => i.id === id)!.state).toBe("disconnected");
    expect((await integrations.session()).mcpServers).toEqual({});
    const again = await integrations.setBearer(id, "t1");
    expect(again.tools.find((t) => t.name === "lookup")!.policy).toBe("off");
    await integrations.remove(id);
    expect(secrets.entries.size).toBe(0);
    expect(integrations.list().some((i) => i.id === id)).toBe(false);
  } finally {
    await s.stop(true);
  }
});

test("a built-in rejects a token it has no auth for", async () => {
  const gmail = integrations.list().find((i) => i.catalogId === "gmail")!;
  await expect(integrations.setBearer(gmail.id, "x")).rejects.toThrow(InvalidInput);
});

const fixture = `${import.meta.dir}/../testing/stdio-server.ts`;
const addLocal = (name = "loc", env: Record<string, string> = { FIXTURE_SECRET: "s3cret-value" }) =>
  integrations.addCustom({
    name,
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    env,
  });

test("a local server is discovered by launching its command, and its env value reaches the process", async () => {
  const i = await addLocal();
  expect(i.state).toBe("connected");
  expect(i.tools.map((t) => [t.name, t.policy])).toEqual([
    ["echo_secret", "auto"],
    ["wipe", "ask"],
  ]);
});

test("session output carries command, arguments and stored env values; listings expose names only", async () => {
  await addLocal();
  expect((await integrations.session()).mcpServers).toEqual({
    loc: {
      type: "stdio",
      command: process.execPath,
      args: [fixture],
      env: { FIXTURE_SECRET: "s3cret-value" },
    },
  } as never);
  const listed = JSON.stringify(integrations.list());
  expect(listed).toContain("FIXTURE_SECRET");
  expect(listed).not.toContain("s3cret-value");
});

test("a command that fails to start is failed with the error and the session still opens", async () => {
  await add("fx");
  const bad = await integrations.addCustom({
    name: "bad",
    transport: "stdio",
    command: "/nonexistent/tomte-cmd",
    args: [],
  });
  expect(bad.state).toBe("failed");
  expect(bad.error).toBeTruthy();
  expect(Object.keys((await integrations.session()).mcpServers)).toEqual(["fx"]);
});

test("Off, Ask and Auto apply to local tools like remote ones", async () => {
  const { id } = await addLocal();
  integrations.setPolicy(id, "echo_secret", "off");
  expect(integrations.decide("mcp__loc__echo_secret")).toBe("deny");
  expect((await integrations.session()).disallowedTools).toEqual(["mcp__loc__echo_secret"]);
  integrations.setPolicy(id, "wipe", "auto");
  expect(integrations.decide("mcp__loc__wipe")).toBe("allow");
  integrations.setPolicy(id, "wipe", "ask");
  expect(integrations.decide("mcp__loc__wipe")).toBe("ask");
});

test("removing a local server deletes its env secret", async () => {
  const { id } = await addLocal();
  expect(secrets.entries.size).toBe(1);
  await integrations.remove(id);
  expect(secrets.entries.size).toBe(0);
});

test("a local server needs a command and valid env names", async () => {
  await expect(
    integrations.addCustom({ name: "x", transport: "stdio", command: "  " }),
  ).rejects.toBeInstanceOf(InvalidInput);
  await expect(
    integrations.addCustom({
      name: "x",
      transport: "stdio",
      command: "bun",
      env: { "BAD-KEY": "1" },
    }),
  ).rejects.toBeInstanceOf(InvalidInput);
});

test("the session config launches a server that sees the stored secret", async () => {
  await addLocal();
  const cfg = (await integrations.session()).mcpServers["loc" as ServerName] as {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  const client = new Client({ name: "t", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: { ...getDefaultEnvironment(), ...cfg.env },
    }),
  );
  const res = (await client.callTool({ name: "echo_secret", arguments: {} })) as {
    content: { text: string }[];
  };
  await client.close();
  expect(res.content[0]!.text).toBe("s3cret-value");
});

const skillDir = (root: string, name: string, description: string) => {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
  writeFileSync(join(root, name, "extra.txt"), name);
};
const addWithSkills = (skillsDir: string, name = "fx") =>
  integrations.addCustom({ name, url, transport: "http", skillsDir });
const pluginSkills = async () => {
  const { plugins } = await integrations.session();
  return plugins.map((p) => ({
    name: JSON.parse(readFileSync(join(p.path, ".claude-plugin", "plugin.json"), "utf8")).name,
    skills: readdirSync(join(p.path, "skills")).sort(),
    mcp: p.skipMcpDiscovery,
  }));
};

test("a local skills folder lists every skill with its description and builds a plugin of only the enabled ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  skillDir(dir, "alpha", "Does alpha");
  skillDir(dir, "beta", "Does beta");
  const i = await addWithSkills(dir);
  expect(i.skills).toEqual([
    { name: "alpha", description: "Does alpha", enabled: true },
    { name: "beta", description: "Does beta", enabled: true },
  ]);
  expect(await pluginSkills()).toEqual([{ name: "fx", skills: ["alpha", "beta"], mcp: true }]);
  integrations.setSkillEnabled(i.id, "alpha", false);
  expect(await pluginSkills()).toEqual([{ name: "fx", skills: ["beta"], mcp: true }]);
  expect(readFileSync(join(hostDir, "plugins", "fx", "skills", "beta", "extra.txt"), "utf8")).toBe(
    "beta",
  );
  integrations.setSkillEnabled(i.id, "beta", false);
  expect((await integrations.session()).plugins).toEqual([]);
  expect(readdirSync(join(hostDir, "plugins"))).toEqual([]);
  expect((await integrations.session()).mcpServers).toHaveProperty("fx");
});

test("skill switches survive a re-install over the same database and a new skill starts on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  skillDir(dir, "alpha", "Does alpha");
  const db = migrate(new Database(join(mkdtempSync(join(tmpdir(), "db-")), "t.db")));
  const make = () =>
    createIntegrations({ db, secrets, hostDir, oauthRedirectUrl: REDIRECT, onChange: () => {} });
  const first = make();
  const { id } = await first.addCustom({ name: "fx", url, transport: "http", skillsDir: dir });
  first.setSkillEnabled(id, "alpha", false);
  skillDir(dir, "gamma", "New one");
  const again = make();
  expect(
    again
      .list()
      .find((x) => x.id === id)!
      .skills.map((k) => [k.name, k.enabled]),
  ).toEqual([
    ["alpha", false],
    ["gamma", true],
  ]);
  expect(await pluginSkillsOf(again)).toEqual(["gamma"]);
});
const pluginSkillsOf = async (m: Integrations) =>
  (await m.session()).plugins.flatMap((p) => readdirSync(join(p.path, "skills")));

test("a missing skills folder is an inline error and the session still opens with tools", async () => {
  const i = await addWithSkills(join(tmpdir(), "no-such-skills-dir"));
  expect(i.state).toBe("connected");
  expect(i.skillsError).toContain("not found");
  const s = await integrations.session();
  expect(s.plugins).toEqual([]);
  expect(Object.keys(s.mcpServers)).toEqual(["fx"]);
});

test("a skills folder must be an absolute path", async () => {
  await expect(addWithSkills("relative/dir")).rejects.toBeInstanceOf(InvalidInput);
});

test("disabling or disconnecting an integration stops its skills loading; remove deletes the plugin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  skillDir(dir, "alpha", "Does alpha");
  const { id } = await addWithSkills(dir);
  integrations.setEnabled(id, false);
  expect((await integrations.session()).plugins).toEqual([]);
  integrations.setEnabled(id, true);
  expect(await pluginSkills()).toHaveLength(1);
  await integrations.disconnect(id);
  expect((await integrations.session()).plugins).toEqual([]);
  await integrations.remove(id);
  expect(readdirSync(join(dir))).toEqual(["alpha"]);
  expect(readdirSync(join(hostDir, "plugins"))).toEqual([]);
});

test("connecting a built-in with a skills repo clones it once into the host folder and lists its skills", async () => {
  const s = authed("cf");
  const repos: string[] = [];
  const cloned = createIntegrations({
    db: migrate(new Database(":memory:")),
    secrets,
    hostDir,
    oauthRedirectUrl: REDIRECT,
    onChange: () => {},
    catalog: [
      {
        id: "cf",
        label: "CF",
        url: `http://127.0.0.1:${s.port}/mcp`,
        auth: { kind: "bearer" },
        skillsRepo: "https://example.test/cf/skills.git",
        ...SHOWN,
      },
    ],
    gitClone: async (repo, dest) => {
      repos.push(repo);
      skillDir(join(dest, "skills"), "wrangler", "Run Wrangler");
      skillDir(join(dest, "skills"), "workers", "Build Workers");
    },
  });
  try {
    const { id } = cloned.list()[0]!;
    expect(cloned.list()[0]!.skills).toEqual([]);
    const i = await cloned.setBearer(id, "cf");
    expect(i.skills.map((k) => k.name)).toEqual(["workers", "wrangler"]);
    await cloned.probe(id);
    expect(repos).toEqual(["https://example.test/cf/skills.git"]);
    expect(readdirSync(join(hostDir, "skills", "cf", "skills")).sort()).toEqual([
      "workers",
      "wrangler",
    ]);
    cloned.setSkillEnabled(id, "workers", false);
    expect(await pluginSkillsOf(cloned)).toEqual(["wrangler"]);
    await cloned.disconnect(id);
    expect((await cloned.session()).plugins).toEqual([]);
  } finally {
    await s.stop(true);
  }
});

test("a failed clone is an inline error and the connection still works", async () => {
  const s = authed("cf");
  const cloned = createIntegrations({
    db: migrate(new Database(":memory:")),
    secrets,
    hostDir,
    oauthRedirectUrl: REDIRECT,
    onChange: () => {},
    catalog: [
      {
        id: "cf",
        label: "CF",
        url: `http://127.0.0.1:${s.port}/mcp`,
        auth: { kind: "bearer" },
        skillsRepo: "x",
        ...SHOWN,
      },
    ],
    gitClone: async () => {
      throw new Error("git clone failed: offline");
    },
  });
  try {
    const i = await cloned.setBearer(cloned.list()[0]!.id, "cf");
    expect(i.state).toBe("connected");
    expect(i.skillsError).toBe("git clone failed: offline");
    expect((await cloned.session()).plugins).toEqual([]);
  } finally {
    await s.stop(true);
  }
});

test("OAuth: Connect returns an authorize URL, the right state stores tokens and lists tools, and a reconnect restores tool choices", async () => {
  const f = oauthFixture();
  try {
    const { id } = await integrations.addCustom({
      name: "oa",
      url: f.url,
      transport: "http",
      oauth: true,
    });
    expect(integrations.list().find((i) => i.id === id)).toMatchObject({
      state: "disconnected",
      auth: { kind: "oauth" },
    });

    const { authorizeUrl } = await integrations.connectOAuth(id);
    const { a, code, state } = f.approve(authorizeUrl);
    expect(a.pathname).toBe("/authorize");
    expect(a.searchParams.get("code_challenge_method")).toBe("S256");
    expect(a.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(secrets.entries.size).toBe(0);

    const done = await integrations.finishOAuth(state, { code });
    expect(done.state).toBe("connected");
    expect(done.tools.map((t) => t.name).sort()).toEqual(["delete_all", "lookup"]);
    const session = await integrations.session();
    expect(Object.keys(session.mcpServers)).toEqual(["oa"]);
    expect(JSON.stringify(session.mcpServers["oa" as ServerName])).toContain("Bearer at-");
    expect(JSON.stringify(integrations.list())).not.toContain("at-");

    integrations.setPolicy(id, "lookup", "off");
    await integrations.disconnect(id);
    expect(secrets.entries.size).toBe(0);
    const again = f.approve((await integrations.connectOAuth(id)).authorizeUrl);
    const back = await integrations.finishOAuth(again.state, { code: again.code });
    expect(back.tools.find((t) => t.name === "lookup")!.policy).toBe("off");
  } finally {
    await f.server.stop(true);
  }
});

test("OAuth: an unknown state returns InvalidInput and stores nothing", async () => {
  const f = oauthFixture();
  try {
    const { id } = await integrations.addCustom({
      name: "oa",
      url: f.url,
      transport: "http",
      oauth: true,
    });
    const before = changes;
    await expect(integrations.finishOAuth("made-up", { code: "x" })).rejects.toBeInstanceOf(
      InvalidInput,
    );
    expect(secrets.entries.size).toBe(0);
    expect(integrations.list().find((i) => i.id === id)!.state).toBe("disconnected");
    expect(changes).toBe(before);
  } finally {
    await f.server.stop(true);
  }
});

test("OAuth: a sign-in completed after ten minutes is refused, stores nothing, and a fresh Connect works", async () => {
  const f = oauthFixture();
  try {
    const { id } = await integrations.addCustom({
      name: "oa",
      url: f.url,
      transport: "http",
      oauth: true,
    });
    const stale = f.approve((await integrations.connectOAuth(id)).authorizeUrl);
    clock += 10 * 60_000 + 1;
    await expect(
      integrations.finishOAuth(stale.state, { code: stale.code }),
    ).rejects.toBeInstanceOf(InvalidInput);
    expect(secrets.entries.size).toBe(0);
    const fresh = f.approve((await integrations.connectOAuth(id)).authorizeUrl);
    expect((await integrations.finishOAuth(fresh.state, { code: fresh.code })).state).toBe(
      "connected",
    );
  } finally {
    await f.server.stop(true);
  }
});

test("OAuth: a state is single-use", async () => {
  const f = oauthFixture();
  try {
    const { id } = await integrations.addCustom({
      name: "oa",
      url: f.url,
      transport: "http",
      oauth: true,
    });
    const x = f.approve((await integrations.connectOAuth(id)).authorizeUrl);
    await integrations.finishOAuth(x.state, { code: x.code });
    await expect(integrations.finishOAuth(x.state, { code: x.code })).rejects.toBeInstanceOf(
      InvalidInput,
    );
  } finally {
    await f.server.stop(true);
  }
});

test("OAuth: an access token near expiry is refreshed for the session, and a failed refresh needs sign-in", async () => {
  const f = oauthFixture();
  try {
    const { id } = await integrations.addCustom({
      name: "oa",
      url: f.url,
      transport: "http",
      oauth: true,
    });
    const x = f.approve((await integrations.connectOAuth(id)).authorizeUrl);
    await integrations.finishOAuth(x.state, { code: x.code });
    const first = JSON.stringify((await integrations.session()).mcpServers["oa" as ServerName]);
    expect((await integrations.session()).expiresAt).toBe(clock + 3600_000 - 5 * 60_000);

    clock += 3600_000;
    const second = JSON.stringify((await integrations.session()).mcpServers["oa" as ServerName]);
    expect(second).not.toBe(first);
    expect(second).toContain("Bearer at-");

    clock += 3600_000;
    for (const k of secrets.entries.keys()) {
      const v = JSON.parse(secrets.entries.get(k)!);
      v.oauth.tokens.refresh_token = "revoked";
      await secrets.set(k, JSON.stringify(v));
    }
    expect((await integrations.session()).mcpServers).toEqual({});
    expect(integrations.list().find((i) => i.id === id)!.state).toBe("needs-auth");
  } finally {
    await f.server.stop(true);
  }
});

test("OAuth: a token 4 minutes from expiry is refreshed; 10 minutes out is left alone", async () => {
  const f = oauthFixture();
  try {
    const { id } = await integrations.addCustom({
      name: "oa",
      url: f.url,
      transport: "http",
      oauth: true,
    });
    const x = f.approve((await integrations.connectOAuth(id)).authorizeUrl);
    await integrations.finishOAuth(x.state, { code: x.code });
    const first = JSON.stringify((await integrations.session()).mcpServers["oa" as ServerName]);
    clock += 3600_000 - 10 * 60_000;
    expect(JSON.stringify((await integrations.session()).mcpServers["oa" as ServerName])).toBe(
      first,
    );
    clock += 6 * 60_000;
    const refreshed = await integrations.session();
    expect(JSON.stringify(refreshed.mcpServers["oa" as ServerName])).not.toBe(first);
    expect(refreshed.expiresAt).toBe(clock + 3600_000 - 5 * 60_000);
  } finally {
    await f.server.stop(true);
  }
});

const fx = () => integrations.list().find((x) => x.name === "fx")!;
test("reconcile: needs-auth and failed update the card, new tools are added with defaults and keep earlier choices", async () => {
  const i = await add("fx");
  integrations.setPolicy(i.id, "lookup", "off");
  const before = changes;
  integrations.reconcile([
    {
      name: "fx",
      status: "connected",
      tools: [
        { name: "lookup", annotations: { readOnly: true } },
        { name: "fresh_read", description: "d", annotations: { readOnly: true } },
        { name: "fresh_write" },
      ],
    },
  ]);
  const tools = Object.fromEntries(fx().tools.map((t) => [t.name, t.policy]));
  expect(tools).toMatchObject({ lookup: "off", fresh_read: "auto", fresh_write: "ask" });
  expect(changes).toBe(before + 1);
  integrations.reconcile([{ name: "fx", status: "failed", error: "boom" }]);
  expect(fx()).toMatchObject({ state: "failed", error: "boom" });
  await integrations.probe(i.id);
  integrations.reconcile([{ name: "fx", status: "needs-auth" }]);
  expect(fx().state).toBe("needs-auth");
  expect((await integrations.session()).mcpServers).toEqual({});
});

test("reconcile: an OAuth server rejecting its token with HTTP 401 needs sign-in", async () => {
  const f = oauthFixture();
  try {
    const { id } = await integrations.addCustom({
      name: "oa",
      url: f.url,
      transport: "http",
      oauth: true,
    });
    const x = f.approve((await integrations.connectOAuth(id)).authorizeUrl);
    await integrations.finishOAuth(x.state, { code: x.code });
    integrations.reconcile([
      {
        name: "oa",
        status: "failed",
        error: "Server rejected the configured Authorization header (HTTP 401).",
      },
    ]);
    expect(integrations.list().find((i) => i.id === id)).toMatchObject({
      state: "needs-auth",
      error: null,
    });
  } finally {
    await f.server.stop(true);
  }
});

test("OAuth: an integration without OAuth refuses to start a sign-in", async () => {
  await expect(integrations.connectOAuth((await add()).id)).rejects.toBeInstanceOf(InvalidInput);
});

const OWN = { appLabel: "test app", steps: ["do it"], scope: "mail.read mail.write" };
function ownClientIntegrations(f: ReturnType<typeof oauthFixture>, auth: "oauth" | "bearer") {
  secrets = memorySecrets();
  const catalog: CatalogEntry[] = [
    {
      id: "own",
      label: "Own",
      url: f.url,
      auth:
        auth === "oauth"
          ? { kind: "oauth", client: "own", ownClient: OWN }
          : { kind: "bearer", ownClient: OWN },
      ...SHOWN,
    },
  ];
  integrations = createIntegrations({
    db: migrate(new Database(":memory:")),
    secrets,
    hostDir,
    now: () => clock,
    onChange: () => {},
    oauthRedirectUrl: REDIRECT,
    catalog,
  });
  return integrations.list()[0]!.id;
}

for (const kind of ["oauth", "bearer"] as const) {
  test(`own client (${kind} card): the user's client is presented instead of registering one, and its secret stays in the keychain`, async () => {
    const f = oauthFixture({ id: "mine", secret: "s3cret" });
    try {
      const id = ownClientIntegrations(f, kind);
      expect(integrations.list()[0]!.redirectUrl).toBe(REDIRECT);
      await expect(integrations.connectOAuth(id)).rejects.toBeInstanceOf(InvalidInput);
      await expect(
        integrations.connectOAuth(id, { clientId: "mine", clientSecret: " " }),
      ).rejects.toBeInstanceOf(InvalidInput);

      const x = f.approve(
        (await integrations.connectOAuth(id, { clientId: "mine", clientSecret: "s3cret" }))
          .authorizeUrl,
      );
      expect(x.a.searchParams.get("client_id")).toBe("mine");
      expect(x.a.searchParams.get("scope")).toBe(OWN.scope);
      expect(f.registrations()).toBe(0);
      expect(secrets.entries.size).toBe(0);

      const done = await integrations.finishOAuth(x.state, { code: x.code });
      expect(done.state).toBe("connected");
      expect(done.tools.length).toBe(2);
      expect(JSON.stringify(integrations.list())).not.toContain("s3cret");
      expect([...secrets.entries.values()].join()).toContain("s3cret");
      expect(JSON.stringify((await integrations.session()).mcpServers)).toContain("Bearer at-");

      await integrations.disconnect(id);
      expect(JSON.stringify(integrations.list())).not.toContain("s3cret");
      const left = [...secrets.entries.values()].join();
      expect(left).toContain("s3cret");
      expect(left).not.toContain("at-");
      expect((await integrations.session()).mcpServers).toEqual({});
    } finally {
      await f.server.stop(true);
    }
  });
}

test("own client: wrong credentials show the provider's error and store nothing", async () => {
  const f = oauthFixture({ id: "mine", secret: "s3cret" });
  try {
    const id = ownClientIntegrations(f, "oauth");
    const x = f.approve(
      (await integrations.connectOAuth(id, { clientId: "mine", clientSecret: "wrong" }))
        .authorizeUrl,
    );
    const done = await integrations.finishOAuth(x.state, { code: x.code });
    expect(done.state).toBe("failed");
    expect(done.error).toContain("client credentials are incorrect");
    expect(secrets.entries.size).toBe(0);
    const refused = f.approve(
      (await integrations.connectOAuth(id, { clientId: "mine", clientSecret: "s3cret" }))
        .authorizeUrl,
    );
    expect(
      (await integrations.finishOAuth(refused.state, { error: "access_denied" })).error,
    ).toContain("access_denied");
    expect(secrets.entries.size).toBe(0);
  } finally {
    await f.server.stop(true);
  }
});

test("a Google authorization URL asks for offline access and fresh consent; other issuers' URLs are left alone", () => {
  const google = withOfflineAccess(
    new URL("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"),
  );
  expect(google.searchParams.get("access_type")).toBe("offline");
  expect(google.searchParams.get("prompt")).toBe("consent");
  const other = withOfflineAccess(new URL("https://mcp.linear.app/authorize?client_id=x"));
  expect(other.searchParams.has("access_type")).toBe(false);
  expect(other.searchParams.has("prompt")).toBe(false);
});

test("own client: built-ins sharing an app label sign in with the client entered once", async () => {
  const f = oauthFixture({ id: "mine", secret: "s3cret" });
  try {
    const catalog: CatalogEntry[] = ["one", "two"].map((id) => ({
      id,
      label: id,
      url: f.url,
      auth: { kind: "oauth", client: "own", ownClient: { ...OWN, scope: id } },
      ...SHOWN,
    }));
    const db = migrate(new Database(":memory:"));
    integrations = createIntegrations({
      db,
      secrets,
      hostDir,
      now: () => clock,
      onChange: () => {},
      oauthRedirectUrl: REDIRECT,
      catalog,
    });
    const [one, two] = integrations.list().map((i) => i.id);
    await expect(integrations.connectOAuth(two!)).rejects.toBeInstanceOf(InvalidInput);
    await expect(integrations.setBearer(two!, "t")).rejects.toBeInstanceOf(InvalidInput);
    expect(rows(db)).toBe(0);
    const x = f.approve(
      (await integrations.connectOAuth(one!, { clientId: "mine", clientSecret: "s3cret" }))
        .authorizeUrl,
    );
    expect((await integrations.finishOAuth(x.state, { code: x.code })).state).toBe("connected");
    const y = f.approve((await integrations.connectOAuth(two!)).authorizeUrl);
    expect([y.a.searchParams.get("client_id"), y.a.searchParams.get("scope")]).toEqual([
      "mine",
      "two",
    ]);
    expect((await integrations.finishOAuth(y.state, { code: y.code })).state).toBe("connected");
  } finally {
    await f.server.stop(true);
  }
});

const MOVED = "https://tomte.example.com/oauth/callback";

/** One database and keychain, two hosts: an integration signs in under `REDIRECT`, then a host with `to` as its redirect URL takes over. `edit` rewrites the stored secret first. */
async function signedInThenMoved(
  f: ReturnType<typeof oauthFixture>,
  to: string,
  edit: (oauth: Record<string, any>) => void = () => {},
) {
  const db = migrate(new Database(":memory:"));
  const host = (oauthRedirectUrl: string) =>
    createIntegrations({
      db,
      secrets,
      hostDir,
      now: () => clock,
      onChange: () => {},
      oauthRedirectUrl,
    });
  const before = host(REDIRECT);
  const { id } = await before.addCustom({ name: "oa", url: f.url, transport: "http", oauth: true });
  const x = f.approve((await before.connectOAuth(id)).authorizeUrl);
  await before.finishOAuth(x.state, { code: x.code });
  for (const [k, v] of secrets.entries) {
    const secret = JSON.parse(v);
    edit(secret.oauth);
    await secrets.set(k, JSON.stringify(secret));
  }
  return { id, after: host(to) };
}

test("OAuth: a client registered for another redirect URL registers again on the next connect, and its tokens keep working until then", async () => {
  const f = oauthFixture();
  try {
    const { id, after } = await signedInThenMoved(f, MOVED);
    expect(JSON.stringify((await after.session()).mcpServers["oa" as ServerName])).toContain(
      "Bearer at-",
    );

    const x = f.approve((await after.connectOAuth(id)).authorizeUrl);
    expect(x.a.searchParams.get("redirect_uri")).toBe(MOVED);
    expect(f.registeredRedirects()).toEqual([[REDIRECT], [MOVED]]);
    expect(JSON.stringify((await after.session()).mcpServers["oa" as ServerName])).toContain(
      "Bearer at-",
    );
    expect((await after.finishOAuth(x.state, { code: x.code })).state).toBe("connected");

    const y = f.approve((await after.connectOAuth(id)).authorizeUrl);
    expect(y.a.searchParams.get("client_id")).toBe(x.a.searchParams.get("client_id"));
    expect(f.registrations()).toBe(2);
  } finally {
    await f.server.stop(true);
  }
});

test("OAuth: a connect under the same redirect URL reuses the client", async () => {
  const f = oauthFixture();
  try {
    const { id, after } = await signedInThenMoved(f, REDIRECT);
    f.approve((await after.connectOAuth(id)).authorizeUrl);
    expect(f.registrations()).toBe(1);
  } finally {
    await f.server.stop(true);
  }
});

const BEFORE_RECORDING = (oauth: Record<string, any>) => delete oauth.redirectUrl;

test("OAuth: a client stored before the redirect URL was recorded is judged by the redirect_uris it was registered with", async () => {
  const f = oauthFixture();
  try {
    const same = await signedInThenMoved(f, REDIRECT, BEFORE_RECORDING);
    f.approve((await same.after.connectOAuth(same.id)).authorizeUrl);
    expect(f.registrations()).toBe(1);
  } finally {
    await f.server.stop(true);
  }
  const g = oauthFixture();
  try {
    const moved = await signedInThenMoved(g, MOVED, BEFORE_RECORDING);
    g.approve((await moved.after.connectOAuth(moved.id)).authorizeUrl);
    expect(g.registeredRedirects()).toEqual([[REDIRECT], [MOVED]]);
  } finally {
    await g.server.stop(true);
  }
});

test("OAuth: a stored client with no known redirect URL registers again", async () => {
  const f = oauthFixture();
  try {
    const { id, after } = await signedInThenMoved(f, REDIRECT, (oauth) => {
      delete oauth.redirectUrl;
      delete oauth.client.redirect_uris;
    });
    f.approve((await after.connectOAuth(id)).authorizeUrl);
    expect(f.registrations()).toBe(2);
  } finally {
    await f.server.stop(true);
  }
});

test("own client: a changed redirect URL never replaces the user's client", async () => {
  const f = oauthFixture({ id: "mine", secret: "s3cret" });
  try {
    const db = migrate(new Database(":memory:"));
    const host = (oauthRedirectUrl: string) =>
      createIntegrations({
        db,
        secrets,
        hostDir,
        now: () => clock,
        onChange: () => {},
        oauthRedirectUrl,
        catalog: [
          {
            id: "own",
            label: "Own",
            url: f.url,
            auth: { kind: "oauth", client: "own", ownClient: OWN },
            ...SHOWN,
          },
        ],
      });
    const before = host(REDIRECT);
    const id = before.list()[0]!.id;
    const x = f.approve(
      (await before.connectOAuth(id, { clientId: "mine", clientSecret: "s3cret" })).authorizeUrl,
    );
    await before.finishOAuth(x.state, { code: x.code });

    const y = f.approve((await host(MOVED).connectOAuth(id)).authorizeUrl);
    expect(y.a.searchParams.get("client_id")).toBe("mine");
    expect(y.a.searchParams.get("redirect_uri")).toBe(MOVED);
    expect(f.registrations()).toBe(0);
  } finally {
    await f.server.stop(true);
  }
});
