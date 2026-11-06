import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DataRootLocked } from "../platform/data-root-lock.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const HOLDER = join(import.meta.dir, "../testing/hold-data-root-lock.ts");

let scratch: string;
let hosts: HandoffHost[];
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "data-root-lock-"));
  hosts = [];
});
afterEach(async () => {
  for (const h of hosts.reverse()) await h.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const start = async (dataRoot: string) => {
  const host = await startHandoffHost(["--data-root", dataRoot]);
  hosts.push(host);
  return host;
};
const serves = async (host: HandoffHost) =>
  (await fetch(`${host.server.url}/api/info`).catch(() => undefined))?.status === 200;
const lockedBy = (e: unknown) => (e instanceof DataRootLocked ? e : undefined);

test("a second host on a running host's data root refuses to start naming its pid while the first keeps serving", async () => {
  const root = join(scratch, "state");
  const first = await start(root);

  const error = await start(root).then(
    () => undefined,
    (e) => e,
  );
  expect(lockedBy(error)?.pid).toBe(process.pid);
  expect((error as Error).message).toContain(`pid ${process.pid}`);

  expect(await serves(first)).toBe(true);
});

test("a host starts on a data root after the host that held it closed", async () => {
  const root = join(scratch, "state");
  const first = await start(root);
  await first.stop();
  hosts.pop();

  const second = await start(root);
  expect(await serves(second)).toBe(true);
});

test("a lock left by a process that was killed does not block a new host", async () => {
  const root = join(scratch, "state");
  const child = Bun.spawn(["bun", HOLDER, root], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");

  const blocked = await start(root).then(
    () => undefined,
    (e) => e,
  );
  expect(lockedBy(blocked)?.pid).toBe(child.pid);

  child.kill("SIGKILL");
  await child.exited;

  const host = await start(root);
  expect(await serves(host)).toBe(true);
});

test("hosts on different data roots run side by side", async () => {
  const a = await start(join(scratch, "a"));
  const b = await start(join(scratch, "b"));
  expect(await serves(a)).toBe(true);
  expect(await serves(b)).toBe(true);
});
