import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelProviders } from "@tomte/contract/api";

import { BILLING_ENV } from "../harness/index.ts";
import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";
import { watchEvents, type EventsWatch } from "../testing/watch-events.ts";

// Each test starts a whole host and runs the CLI several times.
setDefaultTimeout(60_000);

const TOKEN = "sk-ant-oat01-fake_synthetic-long-lived-token";
const OTHER = "sk-ant-oat01-fake_another-synthetic-token";
const MODES = {
  remote: ["--mode", "remote", "--secrets-key-file", "/etc/tomte-test/secrets.key"],
  local: [],
} as const;
const ENV_KEYS = [...BILLING_ENV, "CLAUDE_CONFIG_DIR"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let host: HandoffHost;
let watcher: EventsWatch | undefined;
let temp: string;

beforeEach(() => {
  for (const k of BILLING_ENV) delete process.env[k];
});
afterEach(async () => {
  watcher?.stop();
  watcher = undefined;
  await host.stop();
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  rmSync(temp, { recursive: true, force: true });
});

async function start(mode: keyof typeof MODES) {
  temp = realpathSync(mkdtempSync(join(tmpdir(), "claude-token-")));
  process.env.CLAUDE_CONFIG_DIR = join(temp, "host-process-claude");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  host = await startHandoffHost([...MODES[mode]]);
  // The start-up check must be over, or a later sign-out could be answered by it.
  await host.until(() => host.server.signInState() === "signed-in");
}

const claude = async () => {
  const body = await (await host.ui("/api/providers", {})).text();
  expect(body).not.toContain(TOKEN);
  return defined(ModelProviders.parse(JSON.parse(body)).providers[0], "claude");
};
const setToken = (token = TOKEN) => host.ui("/api/providers/claude/token", { token });

/** Opens a new bot and sends it one message, so the CLI is launched; resolves with that launch. */
async function launch(name: string) {
  const bot = host.createBot(name);
  const before = host.launches().length;
  expect((await host.ui("/api/open", { botId: bot })).status).toBe(200);
  expect((await host.ui("/api/send", { text: "hello" })).status).toBe(200);
  await host.until(() => host.messagesOf(bot).length === 1);
  return defined(host.launches()[before], "launch");
}

describe.each(["remote", "local"] as const)("a long-lived token in %s mode", (mode) => {
  test("signs the host in, reaches each CLI child on a descriptor only, survives a restart and signing out follows its removal", async () => {
    await start(mode);
    host.setSignedIn(false);
    expect((await claude()).status).toBe("disconnected");
    watcher = await watchEvents(host);
    await host.until(() => watcher!.hostStatus()?.claude.state === "signed-out");

    const res = await setToken();
    expect(res.status).toBe(200);
    const answer = await res.text();
    expect(answer).not.toContain(TOKEN);
    expect(JSON.parse(answer)).toEqual({ ok: true, status: "connected" });
    expect(host.secretNames()).toContain("claude-long-lived-token");

    const provider = await claude();
    expect(provider.status).toBe("connected");
    expect(provider.longLivedToken).toBe(true);
    expect(provider.gateway).toBeNull();
    await host.until(() => watcher!.hostStatus()?.claude.method === "long-lived-token");
    expect(JSON.stringify(watcher.hostStatus())).not.toContain(TOKEN);

    const first = await launch("Ada");
    expect(first.credential).toEqual({
      variable: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      token: TOKEN,
    });
    expect(Object.values(first.env)).not.toContain(TOKEN);
    for (const name of BILLING_ENV) expect(first.env[name]).toBeUndefined();

    await host.restart([...MODES[mode]]);
    expect((await claude()).longLivedToken).toBe(true);
    expect((await launch("Bea")).credential?.token).toBe(TOKEN);

    expect((await host.ui("/api/providers/claude/token/remove", {})).status).toBe(200);
    expect(host.secretNames()).not.toContain("claude-long-lived-token");
    const after = await claude();
    expect(after.longLivedToken).toBe(false);
    expect(after.status).toBe("disconnected");
    // The CLI's own sign-in is what is left; with it back, a bot's CLI is started with no credential at all.
    host.setSignedIn(true);
    expect((await launch("Cy")).credential).toBeUndefined();
  });

  test("refuses what is not a setup-token token, stores nothing and leaves the token in use alone", async () => {
    await start(mode);
    const wrong = [
      "   ",
      "a1B2c3#d4E5f6",
      "sk-ant-oat01-",
      "sk-ant-api03-abc",
      "sk-ant-oat01-ab cd",
      "sk-ant-oat01-ab#cd",
    ];
    for (const token of wrong) {
      const res = await setToken(token);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("claude setup-token");
    }
    expect(host.secretNames()).not.toContain("claude-long-lived-token");

    expect((await setToken()).status).toBe(200);
    const refused = await setToken("not-a-token");
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("claude setup-token");
    expect((await claude()).longLivedToken).toBe(true);
    expect((await launch("Ada")).credential?.token).toBe(TOKEN);
  });

  test("trims whitespace around a good token before it is stored", async () => {
    await start(mode);
    expect((await setToken(`  ${TOKEN}\n`)).status).toBe(200);
    expect((await launch("Ada")).credential?.token).toBe(TOKEN);
  });

  test("a token the API refuses signs Claude out, though auth status says signed in, until it is replaced or removed", async () => {
    await start(mode);
    watcher = await watchEvents(host);
    const status = () => defined(watcher?.hostStatus(), "host status");
    expect((await setToken()).status).toBe(200);
    await host.until(() => status().claude.method === "long-lived-token");
    expect(status().claude.state).toBe("signed-in");

    host.setInvalidToken(TOKEN);
    await launch("Ada");
    await host.until(() => status().claude.reason === "token-rejected");
    expect(status().claude).toMatchObject({ state: "signed-out", method: "long-lived-token" });
    expect(status().problems).toEqual([{ kind: "claude-signed-out", reason: "token-rejected" }]);
    expect(JSON.stringify(status())).not.toContain(TOKEN);

    // The CLI's own `auth status` still reports signed in; asking it again does not undo the rejection.
    const provider = await claude();
    expect(provider).toMatchObject({ status: "disconnected", longLivedToken: true, account: null });
    expect(status().claude.state).toBe("signed-out");
    expect(host.secretNames()).toContain("claude-long-lived-token-rejected");

    // A restart with the same token starts out rejected, before any turn has failed.
    await host.restart([...MODES[mode]]);
    watcher.stop();
    watcher = await watchEvents(host);
    await host.until(() => watcher?.hostStatus() !== undefined);
    expect(status().claude).toMatchObject({ state: "signed-out", reason: "token-rejected" });
    expect((await claude()).status).toBe("disconnected");

    // A new token ends it.
    expect(await (await setToken(OTHER)).json()).toEqual({ ok: true, status: "connected" });
    await host.until(() => status().claude.state === "signed-in");
    expect(status().claude.reason).toBeUndefined();
    expect(status().problems).toEqual([]);
    expect(host.secretNames()).not.toContain("claude-long-lived-token-rejected");
    expect((await launch("Bea")).credential?.token).toBe(OTHER);

    // Rejected again, then removed: the CLI's own sign-in is what is left.
    host.setInvalidToken(OTHER);
    await launch("Cy");
    await host.until(() => status().claude.reason === "token-rejected");
    expect((await host.ui("/api/providers/claude/token/remove", {})).status).toBe(200);
    await host.until(() => status().claude.state === "signed-in");
    expect(status().claude.reason).toBeUndefined();
    expect(host.secretNames()).not.toContain("claude-long-lived-token-rejected");
  });

  test("a custom provider is used while it is set and the token again once it is removed", async () => {
    await start(mode);
    expect((await setToken()).status).toBe(200);
    const gateway = await host.ui("/api/providers/claude/gateway", {
      baseUrl: "https://gateway.example.test",
      auth: "api_key",
      token: "gw-synthetic-token",
    });
    expect(gateway.status).toBe(200);
    expect((await launch("Ada")).credential).toEqual({
      variable: "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      token: "gw-synthetic-token",
    });

    await host.ui("/api/providers/claude/gateway/remove", {});
    expect((await launch("Bea")).credential?.token).toBe(TOKEN);
  });

  test("plan usage is not asked of a token", async () => {
    await start(mode);
    await setToken();
    expect(await (await host.ui("/api/providers/claude/usage", {})).json()).toMatchObject({
      available: false,
      windows: [],
    });
  });
});

test("the SSH command is offered by a remote host only", async () => {
  await start("remote");
  expect((await claude()).sshCommand).toContain("auth-login");
  await host.stop();
  rmSync(temp, { recursive: true, force: true });
  await start("local");
  expect((await claude()).sshCommand).toBeNull();
});
