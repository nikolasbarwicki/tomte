import { Database } from "bun:sqlite";
// The whole host as the desktop app runs it: `main.ts --sidecar` as a subprocess on a temp data root, with the fake Claude CLI and file secrets, driven over stdin, stdout and HTTP.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceList } from "@tomte/contract/api";
import { LAUNCH_DEVICE_NAME, SESSION_COOKIE, SidecarReady } from "@tomte/contract/sidecar";

import { acquireDataRootLock } from "../platform/data-root-lock.ts";
import { migrate, SCHEMA_VERSION } from "../platform/db.ts";

const REPO = join(import.meta.dir, "../../../..");
const MAIN = join(import.meta.dir, "../main.ts");
const FAKE_CLAUDE = join(import.meta.dir, "../testing/fake-claude.ts");
const WEB_INDEX = join(REPO, "packages/web/dist/index.html");

const newToken = () => randomBytes(32).toString("base64url");

let scratch: string;
let procs: Bun.Subprocess[];

beforeAll(async () => {
  if (existsSync(WEB_INDEX)) return;
  // The host refuses to start without a built UI; building it takes a second or two.
  const build = Bun.spawn(["bun", "run", "build:web"], {
    cwd: REPO,
    stdout: "ignore",
    stderr: "inherit",
  });
  expect(await build.exited).toBe(0);
}, 120_000);
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "sidecar-test-"));
  procs = [];
});
afterEach(async () => {
  for (const p of procs) p.kill("SIGKILL");
  await Promise.all(procs.map((p) => p.exited));
  rmSync(scratch, { recursive: true, force: true });
});

/** The fake CLI as an executable that names its state directory, so the host's environment does not reach it. */
function fakeCli() {
  const stateDir = join(scratch, "fake-claude");
  mkdirSync(stateDir, { recursive: true });
  const path = join(scratch, "claude-wrapper");
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} ${JSON.stringify(stateDir)} "$@"\n`,
  );
  chmodSync(path, 0o755);
  return { path, stateDir };
}

/** This process's environment without any tomte setting of the developer's, with the fake CLI and the file secrets backend. */
function hostEnv(): Record<string, string> {
  const keyFile = join(scratch, "secrets.key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("TOMTE_"),
    ),
  );
  return { ...env, CLAUDE_PATH: fakeCli().path, TOMTE_SECRETS_KEY_FILE: keyFile };
}

const dataRootOf = () => join(scratch, "data");

/** Lines of a process's stdout as they arrive. */
function lines(stream: ReadableStream<Uint8Array>) {
  const all: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let rest = "";
  void (async () => {
    for await (const chunk of stream) {
      rest += new TextDecoder().decode(chunk);
      for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
        const line = rest.slice(0, i);
        rest = rest.slice(i + 1);
        all.push(line);
        waiting.shift()?.(line);
      }
    }
    if (rest) all.push(rest);
  })();
  const next = () => {
    if (all.length) return Promise.resolve(all[0]!);
    const { promise, resolve } = Promise.withResolvers<string>();
    waiting.push(resolve);
    return promise;
  };
  return { all, next };
}

/** Starts the host from source in sidecar mode and writes `token` as the first stdin line, if given. */
async function startSidecar(token: string | undefined, extra: string[] = []) {
  const proc = Bun.spawn(
    [
      process.execPath,
      MAIN,
      "--sidecar",
      "--port",
      "0",
      "--data-root",
      dataRootOf(),
      "--secrets",
      "file",
      ...extra,
    ],
    { cwd: REPO, env: hostEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  procs.push(proc);
  const stdout = lines(proc.stdout);
  const stderr = new Response(proc.stderr).text();
  if (token !== undefined) await proc.stdin.write(`${token}\n`);
  await proc.stdin.flush();
  return { proc, stdout, stderr };
}

/** Starts a sidecar with `token` and waits for its ready line. */
async function startReady(token: string) {
  const sidecar = await startSidecar(token);
  const ready = SidecarReady.parse(JSON.parse(await sidecar.stdout.next()));
  return { ...sidecar, clientUrl: ready.clientUrl };
}

const post = (clientUrl: string, path: string, headers: Record<string, string>, body = {}) =>
  fetch(`${clientUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: clientUrl, ...headers },
    body: JSON.stringify(body),
  });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

const listDevices = async (clientUrl: string, token: string) => {
  const res = await post(clientUrl, "/api/devices/list", bearer(token));
  expect(res.status).toBe(200);
  return DeviceList.parse(await res.json());
};

const live = (pattern: string) => Bun.spawnSync(["pgrep", "-f", pattern]).exitCode === 0;

describe("a host started with --sidecar", () => {
  test("stays up after it reads the launch token, which signs in as a bearer and as the session cookie", async () => {
    const token = newToken();
    const { proc, clientUrl } = await startReady(token);

    await Bun.sleep(500);
    expect(proc.exitCode).toBeNull();

    expect((await post(clientUrl, "/api/devices/list", bearer(token))).status).toBe(200);
    expect((await post(clientUrl, "/api/devices/list", cookie(token))).status).toBe(200);
    expect((await post(clientUrl, "/api/devices/list", bearer(newToken()))).status).toBe(401);
    expect((await post(clientUrl, "/api/devices/list", {})).status).toBe(401);

    expect(await listDevices(clientUrl, token)).toMatchObject([
      { name: LAUNCH_DEVICE_NAME, current: true },
    ]);
  });

  test("a later run on the same data root replaces the earlier launch device", async () => {
    const first = newToken();
    const run1 = await startReady(first);
    await run1.proc.stdin.end();
    expect(await run1.proc.exited).toBe(0);

    const second = newToken();
    const run2 = await startReady(second);

    expect((await post(run2.clientUrl, "/api/devices/list", bearer(first))).status).toBe(401);
    const devices = await listDevices(run2.clientUrl, second);
    expect(devices.map((d) => d.name)).toEqual([LAUNCH_DEVICE_NAME]);
  });

  test("prints exactly one JSON ready line on stdout and never the token", async () => {
    const token = newToken();
    const { proc, stdout, stderr, clientUrl } = await startReady(token);
    expect(new URL(clientUrl).hostname).toBe("127.0.0.1");

    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
    await Bun.sleep(50);

    expect(stdout.all).toHaveLength(1);
    expect(stdout.all.join("\n")).not.toContain(token);
    expect(await stderr).not.toContain(token);
    expect(await stderr).toContain("tomte UI:");
  });

  test("closing stdin shuts the host down with exit 0 and frees the data-root lock", async () => {
    const { proc, clientUrl } = await startReady(newToken());
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);

    await expect(fetch(`${clientUrl}/api/host-info`)).rejects.toThrow();
    acquireDataRootLock(dataRootOf()).release();
  });

  test("SIGTERM after stdin closed shuts down once, with exit 0", async () => {
    const { proc } = await startReady(newToken());
    await proc.stdin.end();
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    acquireDataRootLock(dataRootOf()).release();
  });

  test("ignores lines after the token and keeps running until stdin ends", async () => {
    const { proc, clientUrl } = await startReady(newToken());
    await proc.stdin.write("more input\nand more\n");
    await proc.stdin.flush();
    await Bun.sleep(300);
    expect(proc.exitCode).toBeNull();
    expect((await fetch(`${clientUrl}/api/host-info`)).status).toBe(200);
  });

  test("closing stdin stops a Claude CLI child that is running a turn", async () => {
    const token = newToken();
    const { proc, clientUrl } = await startReady(token);
    const { stateDir } = fakeCli();
    writeFileSync(join(stateDir, "hold"), "");

    const newBot = { name: "Ada", shape: "ball", color: "ink" };
    expect((await post(clientUrl, "/api/bots/new", bearer(token), newBot)).status).toBe(200);
    expect((await post(clientUrl, "/api/send", bearer(token), { text: "hello" })).status).toBe(200);
    const deadline = Date.now() + 15_000;
    while (!live(stateDir) && Date.now() < deadline) await Bun.sleep(50);
    expect(live(stateDir)).toBe(true);

    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
    for (let i = 0; i < 100 && live(stateDir); i++) await Bun.sleep(50);
    expect(live(stateDir)).toBe(false);
  }, 30_000);

  test.each([
    ["a line that is not a launch token", "this is not a launch token"],
    ["a token of the wrong length", newToken().slice(1)],
    ["a line of characters outside base64url", `${newToken().slice(1)}!`],
  ])("exits 2 for %s without echoing it", async (_name, line) => {
    const { proc, stderr } = await startSidecar(line);
    expect(await proc.exited).toBe(2);
    const text = await stderr;
    expect(text).toContain("launch token");
    expect(text).not.toContain(line);
  });

  test("exits 2 when stdin ends before a line", async () => {
    const { proc, stderr } = await startSidecar(undefined);
    await proc.stdin.end();
    expect(await proc.exited).toBe(2);
    expect(await stderr).toContain("launch token");
  });
});

describe("a host started without --sidecar", () => {
  const start = (stdin: "pipe" | Blob) =>
    Bun.spawn(
      [process.execPath, MAIN, "--port", "0", "--data-root", dataRootOf(), "--secrets", "file"],
      { cwd: REPO, env: hostEnv(), stdin, stdout: "pipe", stderr: "pipe" },
    );

  test.each([
    ["/dev/null", () => Bun.file("/dev/null")],
    ["a closed pipe", () => "pipe" as const],
  ])("keeps serving when stdin is %s", async (_name, stdin) => {
    const proc = start(stdin());
    procs.push(proc);
    if (proc.stdin && typeof proc.stdin !== "number") await proc.stdin.end();
    const url = /tomte UI: (\S+)/.exec(await lines(proc.stdout).next())?.[1];
    expect(url).toBeDefined();

    await Bun.sleep(500);
    expect(proc.exitCode).toBeNull();
    expect((await fetch(`${url}/api/host-info`)).status).toBe(200);
  });

  test("exits 2 naming both schema versions and leaves the database as it was when it is newer than the host knows", async () => {
    mkdirSync(dataRootOf(), { recursive: true });
    const file = join(dataRootOf(), "tomte.db");
    const old = migrate(new Database(file, { create: true }));
    old.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    old.run("PRAGMA wal_checkpoint(TRUNCATE)");
    old.close();
    const before = readFileSync(file);

    const proc = start("pipe");
    procs.push(proc);
    const stderr = new Response(proc.stderr).text();

    expect(await proc.exited).toBe(2);
    const text = await stderr;
    expect(text).toContain(`version ${SCHEMA_VERSION + 1}`);
    expect(text).toContain(`version ${SCHEMA_VERSION} this host knows`);
    expect(text).not.toContain("tomte UI:");
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});
