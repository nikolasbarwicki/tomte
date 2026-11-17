import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { setChatMode } from "../bots/index.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const KEY_FILE = "/etc/tomte-test/secrets.key";
const REMOTE = ["--mode", "remote", "--secrets-key-file", KEY_FILE];

const Settings = z.object({
  sandbox: z
    .object({
      enabled: z.boolean(),
      failIfUnavailable: z.boolean(),
      allowUnsandboxedCommands: z.boolean(),
      network: z.record(z.string(), z.unknown()),
      filesystem: z.object({ denyRead: z.array(z.string()) }),
    })
    .optional(),
});

let host: HandoffHost | undefined;
let temp: string;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

async function start(flags: string[]) {
  temp = realpathSync(mkdtempSync(join(tmpdir(), "shell-isolation-")));
  // The Agent SDK reads transcripts from this process's own config directory; keep it away from the real one.
  process.env.CLAUDE_CONFIG_DIR = join(temp, "host-process-claude");
  host = await startHandoffHost(flags);
  return host;
}

afterEach(async () => {
  await host?.stop();
  host = undefined;
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(temp, { recursive: true, force: true });
});

/** What the fake CLI was launched with for the bot's chat: the sandbox the SDK passed in `--settings` and the disallowed tools. */
async function launchOf(h: HandoffHost, botId: string, text = "hello") {
  expect((await h.ui("/api/open", { botId })).status).toBe(200);
  expect((await h.ui("/api/send", { text })).status).toBe(200);
  await h.until(() => h.messagesOf(botId).length >= 1);
  const argv = h.launches().at(-1)!.argv;
  const value = (flag: string) => argv[argv.indexOf(flag) + 1];
  const settings = Settings.parse(
    argv.includes("--settings") ? JSON.parse(value("--settings")!) : {},
  );
  const disallowedArg = argv.find((a) => a.startsWith("--disallowedTools="));
  const disallowed = disallowedArg?.slice("--disallowedTools=".length).split(",") ?? [];
  return { sandbox: settings.sandbox, disallowed };
}

/** The Read-tool deny rules, as the paths they name. */
const readDenied = (disallowed: string[]) =>
  disallowed.flatMap((t) => (t.endsWith("/**)") ? [t.slice("Read(/".length, -"/**)".length)] : []));

describe("remote mode shell isolation", () => {
  test("a bot without the browser runs sandboxed with the whole deny-read list, for the shell and the Read tool", async () => {
    const h = await start(REMOTE);
    const ada = h.createBot("Ada");
    const grace = h.createBot("Grace");
    const { sandbox, disallowed } = await launchOf(h, ada);

    expect(sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      // Public outbound traffic only: no loopback binding, no Unix sockets.
      network: { allowedDomains: ["*"] },
    });
    const denied = sandbox!.filesystem.denyRead;
    const expected = [
      join(h.dataRoot, "tomte.db"),
      join(h.dataRoot, "tomte.db-wal"),
      join(h.dataRoot, "tomte.db-shm"),
      join(h.dataRoot, "secrets.enc"),
      KEY_FILE,
      join(h.dataRoot, "claude"),
      join(homedir(), ".agent-browser"),
      join(h.dataRoot, "bots", grace),
    ];
    expect(denied).toEqual(expect.arrayContaining(expected));
    for (const path of expected) {
      expect(disallowed).toContain(`Read(/${path})`);
      expect(disallowed).toContain(`Read(/${path}/**)`);
    }
    expect(readDenied(disallowed).sort()).toEqual([...denied].sort());
    expect(disallowed).not.toContain("Bash");
  });

  test("a bot's own directory and files stay readable, every other bot's directory is denied", async () => {
    const h = await start(REMOTE);
    const ada = h.createBot("Ada");
    const grace = h.createBot("Grace");
    const { sandbox } = await launchOf(h, ada);

    const denied = sandbox!.filesystem.denyRead;
    expect(denied).toContain(join(h.dataRoot, "bots", grace));
    expect(denied.some((p) => p === join(h.dataRoot, "bots", ada))).toBe(false);
    expect(denied.some((p) => p.startsWith(join(h.dataRoot, "bots", ada)))).toBe(false);
  });

  test("an open session picks up a bot created after it launched", async () => {
    const h = await start(REMOTE);
    const ada = h.createBot("Ada");
    const first = await launchOf(h, ada);
    const launches = h.launches().length;

    const created = await h.ui("/api/bots/new", {
      name: "Grace",
      purpose: "",
      face: "tuft",
      stroke: "ink",
    });
    expect(created.status).toBe(200);
    const grace = z.object({ id: z.string() }).parse(await created.json()).id;
    expect((await h.ui("/api/open", { botId: ada })).status).toBe(200);
    expect((await h.ui("/api/send", { text: "again" })).status).toBe(200);
    await h.until(() => h.launches().length > launches);

    const second = h.launches().at(-1)!.argv;
    expect(second.join(" ")).toContain(join(h.dataRoot, "bots", grace));
    expect(first.sandbox!.filesystem.denyRead).not.toContain(join(h.dataRoot, "bots", grace));
  });

  test("a bot with the browser gets the union once, not a second copy", async () => {
    const h = await start(REMOTE);
    const ada = h.createBot("Ada");
    expect((await h.ui("/api/bots/browser", { botId: ada, enabled: true })).status).toBe(200);
    const { sandbox } = await launchOf(h, ada);

    const denied = sandbox!.filesystem.denyRead;
    expect(denied).toContain(join(h.dataRoot, "secrets.enc"));
    expect(denied.filter((p) => p === join(homedir(), ".agent-browser"))).toHaveLength(1);
  });

  test("a sandbox that cannot run leaves the bot with no shell tools and the Read denies, never unconfined", async () => {
    const h = await start(REMOTE);
    h.setSandboxAvailable(false);
    const ada = h.createBot("Ada");
    h.createBot("Grace");
    const { sandbox, disallowed } = await launchOf(h, ada);

    expect(sandbox).toBeUndefined();
    expect(disallowed).toEqual(
      expect.arrayContaining(["Bash", "PowerShell", "Monitor", "TaskStop"]),
    );
    expect(disallowed).toContain(`Read(/${join(h.dataRoot, "secrets.enc")})`);
    expect(disallowed).toContain(`Read(/${join(h.dataRoot, "claude")}/**)`);
  });

  test("a double-loop bot without a sandbox has no shell tools either, but keeps TaskStop so its front can stop its agents", async () => {
    const h = await start(REMOTE);
    h.setSandboxAvailable(false);
    const ada = h.createBot("Ada");
    setChatMode(h.dataRoot, ada, "double_loop");
    const { sandbox, disallowed } = await launchOf(h, ada);

    expect(sandbox).toBeUndefined();
    expect(disallowed).toEqual(expect.arrayContaining(["Bash", "PowerShell", "Monitor"]));
    expect(disallowed).not.toContain("TaskStop");
    // The worker has no shell to lose: its definition leaves Bash out and the session has no Bash tool.
    expect(h.launches().at(-1)?.agents?.worker?.tools).not.toContain("Bash");
    expect(h.launches().at(-1)?.argv.join(" ")).not.toMatch(/--tools=\S*Bash/);
  });

  test("a browser bot stays without shell tools when the sandbox cannot run", async () => {
    const h = await start(REMOTE);
    const ada = h.createBot("Ada");
    expect((await h.ui("/api/bots/browser", { botId: ada, enabled: true })).status).toBe(200);
    h.setSandboxAvailable(false);
    await h.ui("/api/bots/browser", { botId: ada, enabled: false });
    const { sandbox, disallowed } = await launchOf(h, ada);

    expect(sandbox).toBeUndefined();
    expect(disallowed).toContain("Bash");
  });
});

describe("local mode shell isolation", () => {
  test("a bot without the browser launches without a sandbox or extra denies", async () => {
    const h = await start([]);
    const ada = h.createBot("Ada");
    mkdirSync(join(h.dataRoot, "bots", "other"), { recursive: true });
    const { sandbox, disallowed } = await launchOf(h, ada);

    expect(sandbox).toBeUndefined();
    expect(disallowed).toEqual([]);
  });

  test("a bot with the browser is sandboxed with the engine state denied, as before", async () => {
    const h = await start([]);
    const ada = h.createBot("Ada");
    expect((await h.ui("/api/bots/browser", { botId: ada, enabled: true })).status).toBe(200);
    const { sandbox } = await launchOf(h, ada);

    expect(sandbox!.filesystem.denyRead).toContain(join(homedir(), ".agent-browser"));
    expect(sandbox!.filesystem.denyRead).not.toContain(join(h.dataRoot, "secrets.enc"));
  });
});
