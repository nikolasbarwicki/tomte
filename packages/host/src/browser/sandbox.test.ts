import { describe, expect, test } from "bun:test";
import { claudeHarness } from "../harness/index.ts";
import { browserIsolation, sandboxStatus } from "./sandbox.ts";

const probe = (platform: NodeJS.Platform, have: string[] = []) => ({
  platform,
  exists: (p: string) => have.includes(p),
  onPath: (n: string) => have.includes(n),
});

describe("sandbox availability", () => {
  test("macOS needs sandbox-exec", () => {
    expect(sandboxStatus(probe("darwin", ["/usr/bin/sandbox-exec"])).status).toBe("available");
    expect(sandboxStatus(probe("darwin")).status).toBe("unavailable");
  });

  test("Linux names each missing dependency", () => {
    expect(sandboxStatus(probe("linux", ["bwrap", "socat"])).status).toBe("available");
    expect(sandboxStatus(probe("linux", ["bwrap"]))).toEqual({ status: "unavailable", reason: expect.stringContaining("socat") });
  });

  test("other platforms are unavailable with a reason", () => {
    expect(sandboxStatus(probe("win32"))).toEqual({ status: "unavailable", reason: expect.stringContaining("win32") });
  });
});

describe("claude isolation profile", () => {
  const launch = (isolation = {}) => claudeHarness.launch({ hostServers: [], systemPromptAppend: "", isolation }).options;

  test("browser bots get a hard sandbox with outbound traffic and denied state dir", () => {
    const o = launch(browserIsolation());
    expect(o.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ["*"] },
      filesystem: { denyRead: expect.arrayContaining([expect.stringContaining(".agent-browser")]) },
    });
    expect(o.sandbox?.network?.allowLocalBinding).toBeUndefined();
    expect(o.disallowedTools).toContainEqual(expect.stringMatching(/^Read\(\/\/.*\.agent-browser\/\*\*\)$/));
  });

  test("bots without the browser stay unconfined", () => {
    const o = launch();
    expect(o.sandbox).toBeUndefined();
    expect(o.disallowedTools).toEqual([]);
  });
});
