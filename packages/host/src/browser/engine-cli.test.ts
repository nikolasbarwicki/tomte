import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineError, runEngine, type EngineLaunch } from "./engine-cli.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An engine binary that prints `stdout` and exits. */
function engine(stdout: string): EngineLaunch {
  const binary = join(dir, "engine");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s' '${stdout}'\n`);
  chmodSync(binary, 0o755);
  return { binary, chrome: "", actionPolicy: "", encryptionKey: "", proxy: "" };
}

test("a successful reply resolves with its data", async () => {
  expect(await runEngine(engine('{"success":true,"data":{"ok":1}}'), "b", ["get"])).toEqual({
    ok: 1,
  });
});

test.each([
  ["not JSON", "nope"],
  ["an envelope of the wrong shape", '{"success":"yes"}'],
  ["a failure", '{"success":false,"error":"no tab"}'],
])("%s rejects with EngineError", async (_, stdout) => {
  await expect(runEngine(engine(stdout), "b", ["get"])).rejects.toBeInstanceOf(EngineError);
});
