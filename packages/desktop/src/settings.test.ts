import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSettings } from "./settings.ts";

let dir: string;
let file: string;
const logs: string[] = [];
const log = (m: string) => void logs.push(m);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-settings-test-"));
  file = join(dir, "user-data", "settings.json");
  logs.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => readFileSync(file, "utf8");

describe("the desktop settings", () => {
  test("a first launch writes the defaults, with no local host choice", () => {
    expect(openSettings(file, log).get()).toEqual({ startAtLogin: true });
    expect(read()).toBe('{\n  "startAtLogin": true\n}\n');
  });

  test("a file from before the local host question still parses, and stays unanswered", () => {
    openSettings(file, log);
    writeFileSync(file, '{"startAtLogin":false}');
    const settings = openSettings(file, log).get();
    expect(settings).toEqual({ startAtLogin: false });
    expect(settings.localHost).toBeUndefined();
    expect(logs).toEqual([]);
  });

  test("changing one setting keeps the other, across a relaunch", () => {
    const settings = openSettings(file, log);
    settings.update({ localHost: "while-shown" });
    settings.update({ startAtLogin: false });
    expect(settings.get()).toEqual({ startAtLogin: false, localHost: "while-shown" });
    expect(JSON.parse(read())).toEqual({ startAtLogin: false, localHost: "while-shown" });
    expect(openSettings(file, log).get()).toEqual({
      startAtLogin: false,
      localHost: "while-shown",
    });
  });

  test("a value other than always or while-shown is not valid settings", () => {
    openSettings(file, log);
    writeFileSync(file, '{"startAtLogin":true,"localHost":"never"}');
    expect(openSettings(file, log).get()).toEqual({ startAtLogin: false });
    expect(read()).toBe('{"startAtLogin":true,"localHost":"never"}');
  });

  test("a file that is not valid settings is kept, logged, and nothing registers itself", () => {
    openSettings(file, log);
    writeFileSync(file, '{"startAtLogin":"yes"}');
    expect(openSettings(file, log).get()).toEqual({ startAtLogin: false });
    expect(read()).toBe('{"startAtLogin":"yes"}');
    expect(logs).toHaveLength(1);
  });

  test("unparseable JSON gets the same treatment", () => {
    openSettings(file, log);
    writeFileSync(file, "{");
    expect(openSettings(file, log).get()).toEqual({ startAtLogin: false });
    expect(read()).toBe("{");
  });
});
