import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClaudeStatus } from "@tomte/contract/host-status";

import { parseHostConfig } from "../platform/config.ts";
import {
  BILLING_ENV,
  createClaudeAccess,
  isAuthFailure,
  type ClaudeAccess,
} from "./claude-access.ts";

// Every check starts a process.
setDefaultTimeout(60_000);

const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@b.test" });
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: "none" });

let dir: string;
let access: ClaudeAccess | undefined;
const savedBilling = Object.fromEntries(BILLING_ENV.map((k) => [k, process.env[k]]));

/** A CLI whose `auth status` runs `statusScript` (by default it prints whatever the `answer` file holds) after counting its run in `runs`. */
function cli(statusScript = `cat ${dir}/answer`) {
  const path = join(dir, "claude");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\necho run >> ${dir}/runs\n${statusScript}\n`,
  );
  chmodSync(path, 0o755);
  return { path, source: "CLAUDE_PATH", needsShell: false } as const;
}

const answer = (text: string) => writeFileSync(join(dir, "answer"), text);
const runs = () => readFileSync(join(dir, "runs"), "utf8").trim().split("\n").length;

function open(
  statusScript?: string,
  flags: string[] = [],
  options: Parameters<typeof createClaudeAccess>[2] = {},
) {
  const config = parseHostConfig(
    ["--data-root", join(dir, "data"), ...flags],
    {},
    { platform: "linux", home: dir },
  ).config;
  const seen: ClaudeStatus[] = [];
  access = createClaudeAccess(config, cli(statusScript), options);
  access.onChange((s) => seen.push(s));
  return { access, seen };
}

beforeEach(() => {
  // A developer's own key would otherwise show up as an ignored variable in every test.
  for (const k of BILLING_ENV) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "claude-access-"));
  writeFileSync(join(dir, "runs"), "");
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedBilling))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  access?.close();
  access = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe.each([
  ["local", []],
  ["remote", ["--mode", "remote", "--secrets-key-file", "/etc/tomte-test/secrets.key"]],
] as const)("billing variables in %s mode", (_mode, flags) => {
  test.each(BILLING_ENV)(
    "%s is dropped from the CLI's environment and named as ignored",
    (name) => {
      process.env[name] = "synthetic-value";
      const { access } = open(undefined, [...flags]);
      expect(access.spawnSpec().env[name]).toBeUndefined();
      expect(access.status().ignoredEnv).toEqual([name]);
    },
  );

  test("all of them together are dropped and listed", () => {
    for (const k of BILLING_ENV) process.env[k] = "synthetic-value";
    const { access } = open(undefined, [...flags]);
    expect(
      Object.keys(access.spawnSpec().env).filter((k) =>
        (BILLING_ENV as readonly string[]).includes(k),
      ),
    ).toEqual([]);
    expect(access.status().ignoredEnv).toEqual([...BILLING_ENV]);
  });

  test("the custom provider's token is a credential on a descriptor, and the ignored variables stay out of the environment", () => {
    process.env.ANTHROPIC_API_KEY = "from-the-host";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "from-the-host";
    const { access } = open(undefined, [...flags]);
    access.setGateway({
      baseUrl: "https://gateway.example.test",
      auth: "bearer",
      token: "gw-token",
    });
    const { env, credential } = access.spawnSpec();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example.test");
    expect(env.CLAUDE_CODE_USE_GATEWAY).toBe("1");
    expect(env.CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR).toBe("3");
    expect(credential).toBe("gw-token");
    expect(Object.values(env)).not.toContain("gw-token");
    for (const name of [...BILLING_ENV, "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"])
      if (name !== "ANTHROPIC_BASE_URL") expect(env[name]).toBeUndefined();
    expect(access.status().ignoredEnv).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  });
});

describe("recheck", () => {
  test("starts unknown, then reports what the CLI says and announces a change once", async () => {
    answer(SIGNED_IN);
    const { access, seen } = open();
    expect(access.status()).toEqual({ state: "unknown", ignoredEnv: [], checkedAt: 0 });

    const first = await access.recheck("startup");
    expect(first).toMatchObject({ state: "signed-in", method: "subscription", ignoredEnv: [] });
    expect(first.checkedAt).toBeGreaterThan(0);
    await access.recheck("timer");
    expect(seen.map((s) => s.state)).toEqual(["signed-in"]);

    answer(SIGNED_OUT);
    expect((await access.recheck("timer")).state).toBe("signed-out");
    expect(access.status().method).toBeUndefined();
    answer(SIGNED_IN);
    await access.recheck("timer");
    expect(seen.map((s) => s.state)).toEqual(["signed-in", "signed-out", "signed-in"]);
  });

  test("an answer that cannot be read never replaces a known state, but is the first answer when none is known", async () => {
    const { access, seen } = open();
    answer("not json");
    expect((await access.recheck("startup")).state).toBe("unknown");

    answer(SIGNED_OUT);
    await access.recheck("timer");
    const known = access.status();
    answer("");
    expect(await access.recheck("timer")).toEqual(known);
    expect(seen.map((s) => s.state)).toEqual(["signed-out"]);
  });

  test("callers asking at once share one run of the CLI", async () => {
    answer(SIGNED_IN);
    const { access } = open();
    const all = await Promise.all([
      access.recheck("startup"),
      access.recheck("timer"),
      access.recheck("providers"),
    ]);
    expect(new Set(all.map((s) => s.checkedAt)).size).toBe(1);
    expect(runs()).toBe(1);
  });

  test("a check asked because something just changed is not answered by one that began before", async () => {
    // The script reads its answer, says it started, and only then takes its time to print it.
    const slow = `a=$(cat ${dir}/answer)\ntouch ${dir}/started\nsleep 0.3\necho "$a"`;
    answer(SIGNED_IN);
    const { access } = open(slow);
    const early = access.recheck("timer");
    // The script signals its start through a file; there is nothing else to await.
    while (!existsSync(join(dir, "started"))) await Bun.sleep(10);
    answer(SIGNED_OUT);
    const late = access.recheck("watch");
    expect((await late).state).toBe("signed-out");
    expect((await early).state).toBe("signed-out");
    expect(runs()).toBe(2);
  });

  test("a listener that throws neither stops the others nor fails the check", async () => {
    answer(SIGNED_IN);
    const { access } = open();
    const heard: string[] = [];
    access.onChange(() => {
      throw new Error("listener bug");
    });
    access.onChange((s) => heard.push(s.state));
    expect((await access.recheck("startup")).state).toBe("signed-in");
    expect(heard).toEqual(["signed-in"]);
  });

  test("a custom provider is the method, and setting it asks again", async () => {
    answer(SIGNED_IN);
    const { access, seen } = open();
    await access.recheck("startup");
    access.setGateway({ baseUrl: "https://gateway.example.test", auth: "bearer", token: "t" });
    expect(access.status().method).toBe("custom-provider");
    expect(seen.map((s) => s.method)).toEqual(["subscription", "custom-provider"]);
    access.setGateway(undefined);
    await access.recheck("providers");
    expect(access.status().method).toBe("subscription");
  });

  test("a stopped listener hears nothing more", async () => {
    answer(SIGNED_IN);
    const { access } = open();
    const heard: string[] = [];
    const stop = access.onChange((s) => heard.push(s.state));
    stop();
    await access.recheck("startup");
    expect(heard).toEqual([]);
  });
});

describe("credentials on a descriptor", () => {
  /** An `auth status` that records its environment and, when the long-lived token names it, what it reads from descriptor 3. */
  const script = () =>
    `env > ${dir}/env\n[ -n "$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" ] && cat <&3 > ${dir}/credential\ncat ${dir}/answer`;
  const TOKEN = "tomte-synthetic-long-lived-token";

  test("a long-lived token is the method, and the CLI reads it from descriptor 3 and never from the environment", async () => {
    answer(SIGNED_IN);
    const { access, seen } = open(script());
    await access.recheck("startup");
    access.setLongLivedToken(TOKEN);
    expect(access.hasLongLivedToken()).toBe(true);
    expect(access.status().method).toBe("long-lived-token");

    const { env, credential } = access.spawnSpec();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe("3");
    expect(credential).toBe(TOKEN);
    expect(Object.values(env)).not.toContain(TOKEN);

    await access.recheck("providers");
    expect(readFileSync(join(dir, "credential"), "utf8")).toBe(TOKEN);
    expect(readFileSync(join(dir, "env"), "utf8")).not.toContain(TOKEN);
    expect(seen.map((s) => s.method)).toEqual(["subscription", "long-lived-token"]);
  });

  test("clearing the token goes back to the CLI's own sign-in, and a check with no credential hands none over", async () => {
    answer(SIGNED_OUT);
    const { access } = open(script());
    access.setLongLivedToken(TOKEN);
    await access.recheck("providers");
    rmSync(join(dir, "credential"));

    access.setLongLivedToken(undefined);
    expect(access.hasLongLivedToken()).toBe(false);
    expect(access.spawnSpec()).not.toHaveProperty("credential");
    expect((await access.recheck("providers")).state).toBe("signed-out");
    expect(existsSync(join(dir, "credential"))).toBe(false);
  });

  test("a custom provider wins over a long-lived token, and an API key goes on its own variable", () => {
    const { access } = open();
    access.setLongLivedToken(TOKEN);
    access.setGateway({ baseUrl: "https://gateway.example.test", auth: "api_key", token: "gw" });
    expect(access.status().method).toBe("custom-provider");
    const { env, credential } = access.spawnSpec();
    expect(credential).toBe("gw");
    expect(env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR).toBe("3");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_GATEWAY).toBeUndefined();
  });

  describe("a long-lived token a turn failed to authenticate with", () => {
    test("is signed out with its reason, auth status cannot clear it, and the host hears of it once", async () => {
      answer(SIGNED_IN);
      const kept: string[] = [];
      const { access, seen } = open(script(), [], { onTokenRejected: (d) => kept.push(d) });
      access.setLongLivedToken(TOKEN);
      await access.recheck("providers");
      expect(access.status()).toMatchObject({ state: "signed-in", method: "long-lived-token" });

      const after = await access.recheck("turn-auth-failure");
      expect(after).toMatchObject({
        state: "signed-out",
        method: "long-lived-token",
        reason: "token-rejected",
      });
      expect(access.report()).toMatchObject({ state: "signed-out", account: null });
      expect(await access.recheck("providers")).toMatchObject({
        state: "signed-out",
        reason: "token-rejected",
      });
      await access.recheck("turn-auth-failure");
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(kept[0]).not.toContain(TOKEN);
      expect(seen.map((s) => s.state)).toEqual(["unknown", "signed-in", "signed-out"]);
    });

    test("clears when the token is replaced or removed, and is remembered for the same token only", async () => {
      answer(SIGNED_IN);
      const kept: string[] = [];
      const { access } = open(script(), [], { onTokenRejected: (d) => kept.push(d) });
      access.setLongLivedToken(TOKEN);
      await access.recheck("turn-auth-failure");
      const digest = kept[0];

      access.setLongLivedToken(`${TOKEN}-2`, digest);
      expect((await access.recheck("providers")).state).toBe("signed-in");
      access.setLongLivedToken(TOKEN, digest);
      expect(access.status()).toMatchObject({ state: "signed-out", reason: "token-rejected" });
      access.setLongLivedToken(TOKEN);
      expect((await access.recheck("providers")).state).toBe("signed-in");
      access.setLongLivedToken(TOKEN, digest);
      access.setLongLivedToken(undefined);
      expect((await access.recheck("providers")).state).toBe("signed-in");
    });

    test("only a long-lived token can be rejected: a failure under a custom provider or the CLI's own sign-in changes nothing", async () => {
      answer(SIGNED_IN);
      const { access } = open(script());
      await access.recheck("startup");
      expect((await access.recheck("turn-auth-failure")).reason).toBeUndefined();
      access.setLongLivedToken(TOKEN);
      access.setGateway({ baseUrl: "https://gateway.example.test", auth: "bearer", token: "gw" });
      expect((await access.recheck("turn-auth-failure")).reason).toBeUndefined();
      access.setGateway(undefined);
      expect(access.status().reason).toBeUndefined();
    });

    test("a remote host refuses to start a run on it, naming Settings", async () => {
      answer(SIGNED_IN);
      const { access } = open(script(), [
        "--mode",
        "remote",
        "--secrets-key-file",
        "/etc/tomte-test/secrets.key",
      ]);
      access.setLongLivedToken(TOKEN);
      await access.recheck("turn-auth-failure");
      await expect(access.requireSignIn()).rejects.toThrow("Settings, Models");
      access.setLongLivedToken(`${TOKEN}-2`);
      await access.recheck("providers");
      await access.requireSignIn();
    });
  });
});

describe("isAuthFailure", () => {
  test.each([
    "turn failed (error_during_execution): Invalid API key · Please run /login",
    "turn failed (success): OAuth token has expired. Please obtain a new token",
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    "Not logged in · Please run /login",
    "authentication_failed",
  ])("%s", (message) => {
    expect(isAuthFailure(new Error(message))).toBe(true);
  });

  test.each([
    "turn failed (error_during_execution): the model gave up",
    "Claude Code exited before the turn produced a result",
    "rate limit reached, try again at 5pm",
    "401 files were attached",
  ])("%s is not one", (message) => {
    expect(isAuthFailure(new Error(message))).toBe(false);
  });

  test("a string counts as its own message, and a non-error is read as text", () => {
    expect(isAuthFailure("Please run /login")).toBe(true);
    expect(isAuthFailure(undefined)).toBe(false);
  });
});
