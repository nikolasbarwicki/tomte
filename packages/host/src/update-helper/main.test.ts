import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { VERSION } from "../harness/index.ts";
import { SCHEMA_VERSION } from "../platform/db.ts";

const MAIN = join(import.meta.dir, "../main.ts");
const run = (...args: string[]) => Bun.spawnSync(["bun", MAIN, ...args], { stdin: "ignore" });

describe("the compiled host's update subcommands", () => {
  test("`version` prints the version and the database schema as one JSON line", () => {
    const r = run("version");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toEqual({
      version: VERSION,
      schemaVersion: SCHEMA_VERSION,
    });
  });

  test.skipIf(process.getuid?.() === 0)("`apply-update` refuses to run as anyone but root", () => {
    const r = run("apply-update");
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("apply-update: apply-update runs as root only");
  });
});
