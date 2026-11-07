import { describe, expect, test } from "bun:test";

import { sandboxStatus } from "./sandbox.ts";

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
    expect(sandboxStatus(probe("linux", ["bwrap"]))).toEqual({
      status: "unavailable",
      reason: expect.stringContaining("socat"),
    });
  });

  test("other platforms are unavailable with a reason", () => {
    expect(sandboxStatus(probe("win32"))).toEqual({
      status: "unavailable",
      reason: expect.stringContaining("win32"),
    });
  });
});
