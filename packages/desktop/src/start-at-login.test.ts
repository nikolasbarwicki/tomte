import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileLoginItem } from "./login-item.ts";
import { openSettings } from "./settings.ts";
import { createStartAtLogin } from "./start-at-login.ts";

let dir: string;
let settings: string;
let item: string;
const logs: string[] = [];
const log = (m: string) => void logs.push(m);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-login-test-"));
  settings = join(dir, "user-data", "settings.json");
  item = join(dir, "login-item.json");
  logs.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as unknown;

describe("Start at login", () => {
  test("is on after the first launch, in the settings file and in the login item", () => {
    const startAtLogin = createStartAtLogin(openSettings(settings, log), fileLoginItem(item));
    expect(startAtLogin.enabled()).toBe(true);
    expect(read(settings)).toEqual({ startAtLogin: true });
    expect(read(item)).toEqual({ openAtLogin: true });
  });

  test("turning it off updates both, and a relaunch keeps it off", () => {
    createStartAtLogin(openSettings(settings, log), fileLoginItem(item)).set(false);
    expect(read(settings)).toEqual({ startAtLogin: false });
    expect(read(item)).toEqual({ openAtLogin: false });

    const relaunched = createStartAtLogin(openSettings(settings, log), fileLoginItem(item));
    expect(relaunched.enabled()).toBe(false);
    expect(read(item)).toEqual({ openAtLogin: false });
  });

  test("every launch applies the setting to the login item, even one the OS lost", () => {
    createStartAtLogin(openSettings(settings, log), fileLoginItem(item));
    fileLoginItem(item).set(false);
    createStartAtLogin(openSettings(settings, log), fileLoginItem(item));
    expect(fileLoginItem(item).get()).toBe(true);
  });

  test("a failed write changes neither the answer nor the login item", () => {
    const startAtLogin = createStartAtLogin(openSettings(settings, log), fileLoginItem(item));
    writeFileSync(join(dir, "blocker"), "");
    const broken = createStartAtLogin(
      openSettings(join(dir, "blocker", "settings.json"), log),
      fileLoginItem(item),
    );
    expect(broken.enabled()).toBe(false);
    expect(() => broken.set(true)).toThrow();
    expect(broken.enabled()).toBe(false);
    expect(startAtLogin.enabled()).toBe(true);
  });
});

describe("fileLoginItem", () => {
  test("is not registered until set, and does not tell the app it was opened at login", () => {
    const login = fileLoginItem(item);
    expect(login.get()).toBe(false);
    expect(login.openedAtLogin()).toBe(false);
    writeFileSync(item, "not json");
    expect(login.get()).toBe(false);
  });
});
