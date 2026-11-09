import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildArgv, readRelayConfig, refuseTarget, type RelayAdapter } from "./relay-config.ts";
import { createRelay } from "./relay.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const adapter = (over: Record<string, unknown> = {}) => ({
  command: "/bin/echo",
  args: ["{agent}", "{message}"],
  ...over,
});

function write(config: unknown, mode = 0o600): string {
  const path = join(dir, "relay.json");
  writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config));
  chmodSync(path, mode);
  return path;
}

const reasonOf = (path: string, remote = false) => {
  const result = readRelayConfig(path, remote);
  return result.ok ? undefined : result.reason;
};

describe("reading the relay configuration", () => {
  test("a valid file gives its adapters with the defaults filled in", () => {
    const result = readRelayConfig(write({ adapters: { herdr: adapter() } }), false);
    expect(result.ok && result.config.adapters.herdr).toEqual({
      command: "/bin/echo",
      args: ["{agent}", "{message}"],
      defaultSession: "default",
      timeoutMs: 10_000,
    });
  });

  test.each([
    ["a missing file", () => join(dir, "nope.json"), "no relay is configured on this host"],
    ["a directory", () => dir, "not a file"],
    [
      "a file others can write",
      () => write({ adapters: {} }, 0o666),
      "writable by group or others",
    ],
    [
      "a file the group can write",
      () => write({ adapters: {} }, 0o620),
      "writable by group or others",
    ],
    ["invalid JSON", () => write("{nope"), "not valid JSON"],
    ["an unknown top-level field", () => write({ adapters: {}, extra: 1 }), "extra"],
    [
      "a relative command",
      () => write({ adapters: { a: adapter({ command: "echo" }) } }),
      "absolute path",
    ],
    [
      "a command with arguments in one string",
      () => write({ adapters: { a: adapter({ command: "echo hi" }) } }),
      "absolute path",
    ],
    [
      "a placeholder inside a longer argument",
      () => write({ adapters: { a: adapter({ args: ["--to={agent}"] }) } }),
      "whole argument",
    ],
    [
      "an unknown placeholder",
      () => write({ adapters: { a: adapter({ args: ["{shell}"] }) } }),
      "whole argument",
    ],
    [
      "an unknown adapter field",
      () => write({ adapters: { a: adapter({ shell: true }) } }),
      "shell",
    ],
    [
      "an agent name starting with a dash",
      () => write({ adapters: { a: adapter({ allowAgents: ["-x"] }) } }),
      "allowAgents",
    ],
    [
      "a timeout that is too short",
      () => write({ adapters: { a: adapter({ timeoutMs: 5 }) } }),
      "timeoutMs",
    ],
    [
      "an adapter name that is not a word",
      () => write({ adapters: { "A B": adapter() } }),
      "adapters",
    ],
  ])("%s is refused with a reason that names no path", (_name, make, why) => {
    const path = make();
    const reason = reasonOf(path);
    expect(reason).toContain(why);
    expect(reason).not.toContain(dir);
  });

  test("remote mode refuses an adapter that does not restrict its agents, local mode does not", () => {
    const path = write({ adapters: { a: adapter() } });
    expect(reasonOf(path, true)).toContain('"a" needs allowAgents in remote mode');
    expect(reasonOf(path, false)).toBeUndefined();
    expect(
      reasonOf(write({ adapters: { a: adapter({ allowAgents: ["coord"] }) } }), true),
    ).toBeUndefined();
  });
});

describe("what an adapter lets through", () => {
  const parsed = (over: Record<string, unknown>): RelayAdapter => {
    const result = readRelayConfig(write({ adapters: { a: adapter(over) } }), false);
    if (!result.ok) throw new Error(result.reason);
    return result.config.adapters.a!;
  };

  test("without allow lists every well-formed target passes", () => {
    expect(
      refuseTarget(parsed({}), { kind: "a", agent: "anyone", session: "any" }),
    ).toBeUndefined();
  });

  test("an agent outside allowAgents and a session outside allowSessions are refused, the default session never is", () => {
    const a = parsed({ allowAgents: ["coord"], allowSessions: ["s1"], defaultSession: "main" });
    expect(refuseTarget(a, { kind: "a", agent: "coord", session: "s1" })).toBeUndefined();
    expect(refuseTarget(a, { kind: "a", agent: "coord" })).toBeUndefined();
    expect(refuseTarget(a, { kind: "a", agent: "coord", session: "main" })).toBeUndefined();
    expect(refuseTarget(a, { kind: "a", agent: "x" })).toContain('agent "x" is not allowed');
    expect(refuseTarget(a, { kind: "a", agent: "coord", session: "s2" })).toContain(
      'session "s2" is not allowed',
    );
  });

  test("the argument list keeps every value whole, whatever it holds", () => {
    const a = parsed({
      args: ["send", "--to", "{agent}", "--", "{message}", "{answer}", "{questionId}", "{session}"],
    });
    const answer = "a b\n$(x) 'q' \"d\" \\ ; | & *";
    expect(
      buildArgv(a, { reply: { kind: "a", agent: "c", session: "s" }, questionId: "Q 1", answer }),
    ).toEqual(["send", "--to", "c", "--", `${answer} (Q 1)`, answer, "Q 1", "s"]);
    expect(
      buildArgv(a, { reply: { kind: "a", agent: "c" }, questionId: undefined, answer: "y" }),
    ).toEqual(["send", "--to", "c", "--", "y", "y", "", "default"]);
  });
});

describe("running an adapter", () => {
  const script = (body: string) => {
    const path = join(dir, "adapter.sh");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const job = { reply: { kind: "a", agent: "coord" }, questionId: undefined, answer: "hi" };
  const run = (body: string, over: Record<string, unknown> = {}) => {
    const config = write({
      adapters: { a: adapter({ command: script(body), args: [], ...over }) },
    });
    return createRelay({ configPath: config, remote: false }).run(job);
  };

  test("exit 0 is delivery", async () => {
    expect(await run("exit 0")).toEqual({ ok: true });
  });

  test("a failure says the exit code and the last line it printed, one line, printable", async () => {
    expect(
      await run("echo first >&2; printf 'agent \\033[31moffline\\033[0m\\t now\\n' >&2; exit 4"),
    ).toEqual({
      error: "adapter.sh exited with 4: agent [31moffline [0m now",
    });
    expect(await run("echo only-stdout; exit 2")).toEqual({
      error: "adapter.sh exited with 2: only-stdout",
    });
    expect(await run("exit 9")).toEqual({ error: "adapter.sh exited with 9" });
  });

  test("a flood of output is cut instead of held, and the error line stays short", async () => {
    const result = await run("yes 'x' | head -c 3000000 >&2; exit 1");
    expect(result).toEqual({ error: expect.stringMatching(/^adapter\.sh exited with 1: x+$/) });
    expect("error" in result && result.error.length).toBeLessThan(260);
  });

  test("a program that is not there is reported as not startable, without its path", async () => {
    const config = write({ adapters: { a: adapter({ command: join(dir, "missing"), args: [] }) } });
    const result = await createRelay({ configPath: config, remote: false }).run(job);
    expect(result).toEqual({ error: "missing could not be started (ENOENT)" });
  });

  test("a program that outlives its timeout is killed and reported as possibly delivered", async () => {
    const started = Date.now();
    const result = await run("exec sleep 30", { timeoutMs: 200 });
    expect(result).toEqual({
      error: "adapter.sh did not finish within 200 ms; the reply may have been delivered",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("stop kills what is running and the run says the host stopped", async () => {
    const started = join(dir, "started");
    const config = write({
      adapters: { a: adapter({ command: script(`touch ${started}\nexec sleep 30`), args: [] }) },
    });
    const relay = createRelay({ configPath: config, remote: false });
    const running = relay.run(job);
    // The kill must land on a running process: wait for the adapter's own marker, not a guessed delay.
    for (let i = 0; i < 400 && !existsSync(started); i++) await Bun.sleep(10);
    expect(existsSync(started)).toBe(true);
    relay.stop();
    expect(await running).toEqual({
      error: "the host stopped before the relay finished; the reply may have been delivered",
    });
  });

  test("a grandchild that keeps the pipes open does not hold the relay up after the adapter exited", async () => {
    const started = Date.now();
    expect(await run("sleep 5 &\nexit 0")).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
