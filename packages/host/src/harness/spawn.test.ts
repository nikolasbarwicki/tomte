import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";

import { cmdExeSpawner, type ResolvedCli } from "./cli.ts";
import { CREDENTIAL_FD, spawnOptions } from "./spawn.ts";

const cli = (needsShell: boolean): ResolvedCli => ({
  path: "/bin/sh",
  source: "CLAUDE_PATH",
  needsShell,
});

describe("spawnOptions", () => {
  test("leaves the spawn to the SDK when there is no credential, and to cmd.exe for a CLI that needs it", () => {
    expect(spawnOptions(cli(false), { env: {} })).toEqual({});
    expect(spawnOptions(cli(true), { env: {} })).toEqual({ spawnClaudeCodeProcess: cmdExeSpawner });
  });

  test("refuses to hand a credential to a CLI that runs through cmd.exe", () => {
    expect(() => spawnOptions(cli(true), { env: {}, credential: "secret" })).toThrow(/cmd\.exe/);
  });

  test("a credential reaches the child on its descriptor to the end of file, and stderr still reaches the caller", async () => {
    const token = "tomte-synthetic-credential";
    const heard: string[] = [];
    const { spawnClaudeCodeProcess } = spawnOptions(
      cli(false),
      { env: {}, credential: token },
      (d) => heard.push(d),
    );
    const child = spawnClaudeCodeProcess!({
      command: "/bin/sh",
      args: ["-c", `cat <&${CREDENTIAL_FD}; echo failing >&2`],
      env: {},
      signal: new AbortController().signal,
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    // `close` is after the exit and the end of every pipe.
    const closed = Promise.withResolvers<void>();
    (child as unknown as ChildProcess).on("close", () => closed.resolve());
    await closed.promise;
    expect(out).toBe(token);
    expect(heard.join("")).toBe("failing\n");
  });

  test("a child that never reads its descriptor is no error for the host", async () => {
    const { spawnClaudeCodeProcess } = spawnOptions(cli(false), {
      env: {},
      credential: "x".repeat(1_000_000),
    });
    const child = spawnClaudeCodeProcess!({
      command: "/bin/sh",
      args: ["-c", "exit 3"],
      env: {},
      signal: new AbortController().signal,
    });
    const exited = Promise.withResolvers<number | null>();
    child.on("exit", (code) => exited.resolve(code));
    expect(await exited.promise).toBe(3);
  });
});
