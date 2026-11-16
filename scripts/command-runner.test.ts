import { describe, expect, test } from "bun:test";

import { CommandError, spawnRunner, stopRunningCommands } from "./command-runner.ts";

describe("spawnRunner", () => {
  test("returns both streams of a command that succeeds", async () => {
    expect(await spawnRunner(["sh", "-c", "printf out; printf err >&2"])).toEqual({
      stdout: "out",
      stderr: "err",
    });
  });

  test("lays the given environment over the process's", async () => {
    const ran = await spawnRunner(["sh", "-c", 'printf "%s" "$SYNTHETIC_RUNNER_VAR"'], {
      SYNTHETIC_RUNNER_VAR: "from-the-caller",
    });
    expect(ran.stdout).toBe("from-the-caller");
  });

  test("a failing command throws its code and streams but names only its first two words", async () => {
    const error = await spawnRunner([
      "sh",
      "-c",
      "printf partial; printf oops >&2; exit 3 # SYNTHETIC-SECRET-ARGUMENT",
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    const failed = error as CommandError;
    expect([failed.code, failed.stdout, failed.stderr]).toEqual([3, "partial", "oops"]);
    expect(failed.message).toBe("sh -c failed (exit 3): oops");
    expect(failed.message).not.toContain("SYNTHETIC-SECRET-ARGUMENT");
  });

  test("stopRunningCommands ends a command that is still running", async () => {
    const pending = spawnRunner(["sleep", "1000"]).catch((e: unknown) => e);
    // spawnRunner registers the child before its first await, so it is already listed here.
    stopRunningCommands();
    const error = await pending;
    expect(error).toBeInstanceOf(CommandError);
  });
});
