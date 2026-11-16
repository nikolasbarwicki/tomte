import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDesktopLog } from "./desktop-log.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-log-test-"));
  spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the desktop log", () => {
  test("appends timestamped lines, creating the folder", () => {
    const file = join(dir, "logs", "desktop.log");
    const log = createDesktopLog(file, () => new Date("2026-11-08T10:00:00.000Z"));
    log("one");
    log("two");
    expect(readFileSync(file, "utf8")).toBe(
      "2026-11-08T10:00:00.000Z [desktop] one\n2026-11-08T10:00:00.000Z [desktop] two\n",
    );
  });

  test("a file that cannot be written is not an error for the app", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file where a folder is needed");
    const log = createDesktopLog(join(blocker, "desktop.log"));
    expect(() => log("still running")).not.toThrow();
  });
});
