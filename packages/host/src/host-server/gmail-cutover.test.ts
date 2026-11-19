import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A host upgraded from a release that connected Gmail through Google's hosted MCP server: the database at schema 29 holds the hosted
// row with its tools and the owner's per-tool settings, and the host that opens it shows a needs-auth built-in card.
import { migrate } from "../platform/db.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const HOSTED_URL = "https://hosted-gmail.example.test/mcp/v1";

const HOSTED_AUTH = {
  kind: "oauth",
  client: "own",
  ownClient: {
    appLabel: "Google OAuth client",
    scope:
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    steps: ["Join the Google Workspace Developer Preview Program with the Google account."],
  },
};

/** What the hosted server reported, and the policy the owner had set for each tool. */
const HOSTED_TOOLS: [string, "auto" | "ask" | "off"][] = [
  ["search_threads", "off"],
  ["get_thread", "ask"],
  ["list_drafts", "auto"],
  ["list_labels", "auto"],
  ["create_draft", "off"],
  ["label_message", "ask"],
  ["label_thread", "off"],
  ["unlabel_message", "auto"],
  ["unlabel_thread", "ask"],
];

let scratch: string;
let host: HandoffHost | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "gmail-cutover-"));
});
afterEach(async () => {
  await host?.stop();
  host = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

function hostedDatabase(dataRoot: string, tools = HOSTED_TOOLS) {
  const db = migrate(new Database(join(dataRoot, "tomte.db"), { create: true }));
  db.query(
    `INSERT INTO integrations (id, catalog_id, name, transport, auth, enabled, state, error, created_at, updated_at)
     VALUES ('catalog:gmail', 'gmail', 'gmail', ?, ?, 1, 'connected', NULL, 1, 1)`,
  ).run(JSON.stringify({ type: "http", url: HOSTED_URL }), JSON.stringify(HOSTED_AUTH));
  for (const [name, policy] of tools)
    db.query(
      `INSERT INTO integration_tools (integration_id, tool_name, description, read_only, destructive, policy, last_seen)
       VALUES ('catalog:gmail', ?, 'hosted', 0, 0, ?, 1)`,
    ).run(name, policy);
  db.run("PRAGMA user_version = 29");
  db.close();
}

type Card = {
  id: string;
  catalogId: string | null;
  state: string;
  error: string | null;
  enabled: boolean;
  transport: { type: string; service?: string; url?: string };
  auth: { ownClient: { scope: string; steps: string[] } };
  tools: { name: string; policy: string; readOnly: boolean; locked: boolean }[];
};

async function startUpgraded(tools = HOSTED_TOOLS) {
  const dataRoot = join(scratch, "state");
  mkdirSync(dataRoot, { recursive: true });
  hostedDatabase(dataRoot, tools);
  const started = await startHandoffHost(["--data-root", dataRoot]);
  host = started;
  return { host: started, ...(await gmailCard(started)) };
}

async function gmailCard(h: HandoffHost) {
  const res = await h.ui("/api/integrations/list", {});
  expect(res.status).toBe(200);
  const cards = (await res.json()) as Card[];
  return { cards, card: defined(cards.find((c) => c.catalogId === "gmail")) };
}

test("a hosted Gmail row becomes one built-in card that asks the owner to sign in", async () => {
  const { cards, card } = await startUpgraded();
  expect(cards.filter((c) => c.catalogId === "gmail")).toHaveLength(1);
  expect(card).toMatchObject({
    id: "catalog:gmail",
    state: "needs-auth",
    error: null,
    enabled: true,
    transport: { type: "builtin", service: "gmail" },
  });
  expect(card.auth.ownClient.scope).toBe("https://www.googleapis.com/auth/gmail.modify");
  expect(JSON.stringify(cards)).not.toContain("hosted-gmail");
  expect(card.auth.ownClient.steps.join(" ")).not.toMatch(/Developer Preview|MCP API|AI-powered/);
});

test("the hosted tools are replaced by the built-in list; only a tool switched Off carries over, label tools onto modify_labels", async () => {
  const { card } = await startUpgraded();
  const byName = Object.fromEntries(card.tools.map((t) => [t.name, t]));
  expect(Object.keys(byName).sort()).toEqual([
    "create_draft",
    "get_attachment",
    "get_thread",
    "list_drafts",
    "list_labels",
    "modify_labels",
    "search_threads",
    "send_message",
    "trash_thread",
    "update_draft",
  ]);
  const policies = Object.fromEntries(card.tools.map((t) => [t.name, t.policy]));
  expect(policies).toEqual({
    search_threads: "off",
    create_draft: "off",
    modify_labels: "off",
    get_thread: "auto",
    list_drafts: "auto",
    list_labels: "auto",
    get_attachment: "auto",
    update_draft: "ask",
    trash_thread: "ask",
    send_message: "ask",
  });
  expect(defined(byName.send_message).locked).toBe(true);
  expect(defined(byName.search_threads)).toMatchObject({ readOnly: true, locked: false });
});

test("a label tool on Ask or Auto does not switch modify_labels off", async () => {
  const { card } = await startUpgraded([
    ["label_thread", "ask"],
    ["unlabel_message", "auto"],
    ["get_thread", "off"],
  ]);
  const policies = Object.fromEntries(card.tools.map((t) => [t.name, t.policy]));
  expect(policies.modify_labels).toBe("ask");
  expect(policies.get_thread).toBe("off");
});

test("the next start leaves the converted card and the owner's settings as they are", async () => {
  const { host: h } = await startUpgraded();
  const set = await h.ui("/api/integrations/set-policy", {
    id: "catalog:gmail",
    tool: "trash_thread",
    policy: "off",
  });
  expect(set.status).toBe(200);
  await h.restart();
  const { card } = await gmailCard(h);
  expect(card.state).toBe("needs-auth");
  expect(card.transport).toEqual({ type: "builtin", service: "gmail" });
  const policies = Object.fromEntries(card.tools.map((t) => [t.name, t.policy]));
  expect(policies).toMatchObject({
    trash_thread: "off",
    search_threads: "off",
    get_thread: "auto",
  });
});
