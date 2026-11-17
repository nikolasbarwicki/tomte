import { describe, expect, test } from "bun:test";

import { createAutoInstall } from "./auto-install.ts";
import type { EngineStatus } from "./engine.ts";

const missing: EngineStatus = {
  status: "unavailable",
  reason: "browser engine not installed; run `tomte-host install-browser`",
  installable: true,
};

describe("the sidecar's browser auto-install", () => {
  test("installs once while running, never names a command, and retries after a failure", async () => {
    const attempts: ReturnType<typeof Promise.withResolvers<void>>[] = [];
    const auto = createAutoInstall(() => {
      const attempt = Promise.withResolvers<void>();
      attempts.push(attempt);
      return attempt.promise;
    });

    const first = auto.status(missing);
    auto.status(missing);
    expect(attempts).toHaveLength(1);
    expect(first.status === "unavailable" && first.reason).toContain("being installed");
    expect(first.status === "unavailable" && first.reason).not.toContain("install-browser");

    attempts[0]!.reject(new Error("download failed: 503"));
    await attempts[0]!.promise.catch(() => {});
    const retried = auto.status(missing);
    expect(attempts).toHaveLength(2);
    expect(retried.status === "unavailable" && retried.reason).toContain("download failed: 503");

    attempts[1]!.resolve();
    await attempts[1]!.promise;
    auto.status(missing);
    expect(attempts).toHaveLength(3);
    expect(auto.status(missing)).not.toHaveProperty("installable");
  });

  test("leaves an available or uninstallable browser alone", () => {
    let calls = 0;
    const auto = createAutoInstall(async () => void calls++);
    const available: EngineStatus = { status: "available", path: "/e", source: "bundled" };
    const unsupported: EngineStatus = { status: "unavailable", reason: "no agent-browser build" };
    expect(auto.status(available)).toBe(available);
    expect(auto.status(unsupported)).toBe(unsupported);
    expect(calls).toBe(0);
  });
});
