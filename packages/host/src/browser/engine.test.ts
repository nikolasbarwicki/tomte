import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostCommand } from "../platform/launch.ts";
import { engineStatus, findChrome, installManagedEngine, resolveEngine } from "./engine.ts";

const envKeys = ["AGENT_BROWSER_PATH", "AGENT_BROWSER_EXECUTABLE_PATH", "PATH"] as const;
const ENGINE = process.platform === "win32" ? "agent-browser.exe" : "agent-browser";
const CHROME =
  process.platform === "darwin"
    ? ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]
    : process.platform === "win32"
      ? ["chrome.exe"]
      : ["chrome"];

describe("engine resolution", () => {
  let dir: string;
  let dataRoot: string;
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const exe = (...p: string[]) => {
    const f = join(dir, ...p);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, "");
    return f;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-"));
    dataRoot = join(dir, "data");
    delete process.env.AGENT_BROWSER_PATH;
    delete process.env.AGENT_BROWSER_EXECUTABLE_PATH;
    process.env.PATH = join(dir, "bin");
  });
  afterEach(() => {
    for (const k of envKeys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    rmSync(dir, { recursive: true, force: true });
  });

  test("unavailable with an install hint when nothing resolves", () => {
    const s = engineStatus(dataRoot, join(dir, "no-bundle"));
    expect(s.status).toBe("unavailable");
    expect(s.status === "unavailable" && s.installable).toBe(true);
    expect(s.status === "unavailable" && s.reason).toContain(
      hostCommand("install-browser", "--data-root", dataRoot),
    );
  });

  test("a bundled engine and Chrome beat a managed install and make the browser available", () => {
    const bundle = join(dir, "Resources", "browser-engine");
    const managed = exe("data", "agent-browser", "0.41.2", ENGINE);
    writeFileSync(join(dataRoot, "agent-browser", "current"), managed);
    expect(resolveEngine(dataRoot, bundle)?.source).toBe("managed");

    const bundled = exe("Resources", "browser-engine", ENGINE);
    expect(resolveEngine(dataRoot, bundle)).toEqual({ path: bundled, source: "bundled" });

    const chrome = exe("Resources", "browser-engine", "chrome", "chrome-platform", ...CHROME);
    expect(findChrome(bundle)).toBe(chrome);
    expect(engineStatus(dataRoot, bundle)).toEqual({
      status: "available",
      path: bundled,
      source: "bundled",
    });

    process.env.AGENT_BROWSER_EXECUTABLE_PATH = exe("my-chrome");
    expect(findChrome(bundle)).toBe(process.env.AGENT_BROWSER_EXECUTABLE_PATH);
  });

  test("prefers override env, then the data root's managed install, then PATH", () => {
    const onPath = exe("bin", process.platform === "win32" ? "agent-browser.exe" : "agent-browser");
    expect(resolveEngine(dataRoot)).toEqual({ path: onPath, source: "PATH" });

    const managed = exe("data", "agent-browser", "0.41.2", "agent-browser");
    writeFileSync(join(dataRoot, "agent-browser", "current"), managed);
    expect(resolveEngine(dataRoot)).toEqual({ path: managed, source: "managed" });

    process.env.AGENT_BROWSER_PATH = exe("fake-engine");
    expect(resolveEngine(dataRoot)?.source).toBe("AGENT_BROWSER_PATH");
    expect(engineStatus(dataRoot).status).toBe("available");
  });

  test("a managed install is found only through the data root it was installed in", () => {
    const managed = exe("data", "agent-browser", "0.41.2", "agent-browser");
    writeFileSync(join(dataRoot, "agent-browser", "current"), managed);
    expect(resolveEngine(dataRoot)?.path).toBe(managed);
    expect(resolveEngine(join(dir, "elsewhere"))).toBeUndefined();
  });

  test("a stale managed marker is ignored", () => {
    mkdirSync(join(dataRoot, "agent-browser"), { recursive: true });
    writeFileSync(join(dataRoot, "agent-browser", "current"), join(dir, "gone"));
    expect(resolveEngine(dataRoot)).toBeUndefined();
  });

  test("refuses a checksum mismatch and installs nothing", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    try {
      await expect(installManagedEngine(dataRoot)).rejects.toThrow("checksum mismatch");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(resolveEngine(dataRoot)).toBeUndefined();
    expect(existsSync(dataRoot) ? readdirSync(dataRoot) : []).toEqual([]);
  });

  test("refuses a version other than the pinned one", async () => {
    await expect(installManagedEngine(dataRoot, "0.0.1")).rejects.toThrow("pinned");
  });
});
