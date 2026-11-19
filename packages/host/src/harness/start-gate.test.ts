import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseHostConfig } from "../platform/config.ts";
import { BILLING_ENV, createClaudeAccess, type ClaudeAccess } from "./claude-access.ts";

// Every start launches a process.
setDefaultTimeout(60_000);

const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@b.test" });

let dir: string;
let accesses: ClaudeAccess[] = [];

/** Real time on purpose: a start that takes a while is what lets an overlap with another show; nothing here asserts on the delay itself. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  for (const k of BILLING_ENV) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "start-gate-"));
});

afterEach(() => {
  for (const a of accesses) a.close();
  accesses = [];
  rmSync(dir, { recursive: true, force: true });
});

/** A CLI that answers signed in and records in `runs` whether the file `held-done` existed when `auth status` ran. */
function statusCli() {
  const path = join(dir, "claude");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\nif [ -e ${dir}/held-done ]; then echo after >> ${dir}/runs; else echo before >> ${dir}/runs; fi\necho '${SIGNED_IN}'\n`,
  );
  chmodSync(path, 0o755);
  return { path, source: "CLAUDE_PATH", needsShell: false } as const;
}

function open(cli: ReturnType<typeof statusCli>, o: { startHoldMs?: number } = {}) {
  const config = parseHostConfig(
    ["--data-root", join(dir, "data")],
    {},
    { platform: "linux", home: dir },
  ).config;
  const access = createClaudeAccess(config, cli, o);
  accesses.push(access);
  return access;
}

describe("startGate", () => {
  test("starts run one at a time, in order, and all complete", async () => {
    const access = open(statusCli());
    let running = 0;
    let most = 0;
    const order: number[] = [];
    const start = (n: number) => async () => {
      most = Math.max(most, ++running);
      await sleep(5);
      running--;
      order.push(n);
      return n * 10;
    };
    const results = await Promise.all([1, 2, 3, 4].map((n) => access.startGate(start(n))));
    expect(results).toEqual([10, 20, 30, 40]);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(most).toBe(1);
  });

  test("a failing start rejects its own caller and does not jam the gate", async () => {
    const access = open(statusCli());
    const failing = access.startGate(async () => {
      throw new Error("no CLI");
    });
    const throwing = access.startGate(() => {
      throw new Error("threw at once");
    });
    const after = access.startGate(async () => "started");
    await expect(failing).rejects.toThrow("no CLI");
    await expect(throwing).rejects.toThrow("threw at once");
    expect(await after).toBe("started");
  });

  test("a start that never answers lets the next one through after the hold", async () => {
    const access = open(statusCli(), { startHoldMs: 50 });
    void access.startGate(() => new Promise<never>(() => {}));
    expect(await access.startGate(async () => "next")).toBe("next");
  });

  test("the hold is counted from when a start begins, not from when it queued", async () => {
    const access = open(statusCli(), { startHoldMs: 150 });
    let running = 0;
    let most = 0;
    const start = async () => {
      most = Math.max(most, ++running);
      await sleep(100);
      running--;
    };
    await Promise.all([1, 2, 3].map(() => access.startGate(start)));
    expect(most).toBe(1);
  });

  test("a sign-in check waits for the start in front of it", async () => {
    const access = open(statusCli());
    const held = access.startGate(async () => {
      await sleep(300);
      writeFileSync(join(dir, "held-done"), "");
    });
    const check = await access.recheck("host-command");
    await held;
    expect(check.state).toBe("signed-in");
    expect(readFileSync(join(dir, "runs"), "utf8").trim().split("\n")).toEqual(["after"]);
  });
});
