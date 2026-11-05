import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineStatus, installManagedEngine, resolveEngine } from "./browser-engine.ts";

const envKeys = ["AGENT_BROWSER_PATH", "CLAUDEBOT_BROWSER_ROOT", "PATH"] as const;

describe("engine resolution", () => {
  let dir: string;
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const exe = (...p: string[]) => {
    const f = join(dir, ...p);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, "");
    return f;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-"));
    delete process.env.AGENT_BROWSER_PATH;
    process.env.CLAUDEBOT_BROWSER_ROOT = join(dir, "managed");
    process.env.PATH = join(dir, "bin");
  });
  afterEach(() => {
    for (const k of envKeys) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("unavailable with an install hint when nothing resolves", () => {
    const s = engineStatus();
    expect(s.status).toBe("unavailable");
    expect(s.status === "unavailable" && s.reason).toContain("install-browser");
  });

  test("prefers override env, then managed cache, then PATH", () => {
    const onPath = exe("bin", process.platform === "win32" ? "agent-browser.exe" : "agent-browser");
    expect(resolveEngine()).toEqual({ path: onPath, source: "PATH" });

    const managed = exe("managed", "0.41.2", "agent-browser");
    writeFileSync(join(dir, "managed", "current"), managed);
    expect(resolveEngine()).toEqual({ path: managed, source: "managed" });

    process.env.AGENT_BROWSER_PATH = exe("fake-engine");
    expect(resolveEngine()?.source).toBe("AGENT_BROWSER_PATH");
    expect(engineStatus().status).toBe("available");
  });

  test("a stale managed marker is ignored", () => {
    mkdirSync(join(dir, "managed"));
    writeFileSync(join(dir, "managed", "current"), join(dir, "gone"));
    expect(resolveEngine()).toBeUndefined();
  });

  test("refuses a checksum mismatch and installs nothing", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    try {
      await expect(installManagedEngine()).rejects.toThrow("checksum mismatch");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(resolveEngine()).toBeUndefined();
  });

  test("refuses a version other than the pinned one", async () => {
    await expect(installManagedEngine("0.0.1")).rejects.toThrow("pinned");
  });
});
