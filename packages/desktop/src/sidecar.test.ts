// The sidecar protocol from the app's side, against a shell script standing in for the host binary.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LaunchToken } from "@tomte/contract/sidecar";

import { SidecarStartError, startSidecar } from "./sidecar.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-sidecar-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** An executable script that stands in for the host. */
function fakeHost(body: string): string {
  const path = join(dir, "host");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const logFile = () => join(dir, "logs", "host.log");
const log = () => readFileSync(logFile(), "utf8");
const READY = `echo '{"type":"ready","clientUrl":"http://127.0.0.1:4123/"}'`;

describe("startSidecar", () => {
  test("writes a launch token first, keeps stdin open, and ends the host by closing it", async () => {
    const host = fakeHost(
      `read token\necho "$token" > "${dir}/token"\n${READY}\ncat > /dev/null\nexit 0`,
    );
    const sidecar = await startSidecar(host, logFile());
    expect(sidecar.clientUrl).toBe("http://127.0.0.1:4123/");
    expect(LaunchToken.safeParse(sidecar.token).success).toBe(true);

    await Bun.sleep(150);
    expect(readFileSync(join(dir, "token"), "utf8").trim()).toBe(sidecar.token);
    let exited = false;
    void sidecar.exited.then(() => (exited = true));
    await Bun.sleep(150);
    expect(exited).toBe(false);

    await sidecar.stop();
    expect(exited).toBe(true);
    expect(log()).toContain("host exited (0)");
    expect(log()).not.toContain(sidecar.token);
  });

  test("every launch gets a different token", async () => {
    const host = fakeHost(`${READY}\ncat > /dev/null`);
    const a = await startSidecar(host, logFile());
    const b = await startSidecar(host, logFile());
    expect(a.token).not.toBe(b.token);
    await Promise.all([a.stop(), b.stop()]);
  });

  test("appends the host's stderr and later stdout to the log", async () => {
    const host = fakeHost(
      `echo "starting" >&2\n${READY}\necho "later stdout line"\ncat > /dev/null`,
    );
    const sidecar = await startSidecar(host, logFile());
    await sidecar.stop();
    expect(log()).toContain("starting");
    expect(log()).toContain("later stdout line");
    expect(log()).not.toContain("clientUrl");
  });

  test("fails with the end of the host's log when the host exits before it is ready", async () => {
    const host = fakeHost(`echo "data root is locked by pid 7" >&2\nexit 2`);
    const error = await startSidecar(host, logFile()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SidecarStartError);
    expect((error as Error).message).toContain("exited before it was ready");
    expect((error as Error).message).toContain("data root is locked by pid 7");
  });

  test("fails when the first stdout line is not a ready message, and stops the host", async () => {
    const host = fakeHost(`echo "hello"\ncat > /dev/null`);
    const error = await startSidecar(host, logFile()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SidecarStartError);
    expect((error as Error).message).toContain("not a ready message");
  });

  test("fails, and stops the host, when no ready line arrives in time", async () => {
    const host = fakeHost(`echo "warming up" >&2\ncat > /dev/null`);
    const error = await startSidecar(host, logFile(), { readyMs: 1000, stopMs: 5000 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SidecarStartError);
    expect((error as Error).message).toContain("was not ready after 1s");
    expect((error as Error).message).toContain("warming up");
  });

  test("kills a host that ignores the end of its stdin", async () => {
    const host = fakeHost(`${READY}\nexec sleep 60`);
    const sidecar = await startSidecar(host, logFile(), { readyMs: 5000, stopMs: 300 });
    await sidecar.stop();
    expect(log()).toContain("did not exit within 0.3s");
    expect(log()).toContain("host exited (SIGKILL)");
  });

  test("fails when there is no host binary", async () => {
    const error = await startSidecar(join(dir, "missing"), logFile()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SidecarStartError);
    expect((error as Error).message).toContain("ENOENT");
  });
});
