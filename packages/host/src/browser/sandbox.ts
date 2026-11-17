import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { IsolationProfile } from "../harness/index.ts";

export type SandboxStatus = { status: "available" } | { status: "unavailable"; reason: string };

/** The engine's state directory (saved logins, encryption material, Chrome); a bot's shell and Read tool must never see it. */
const engineStateDir = () => join(homedir(), ".agent-browser");

/**
 * The isolation a browser-enabled bot runs under. Claude's macOS sandbox always allows the SecurityServer Mach service,
 * so a sandboxed `security` command could read tomte's keychain items; denying the user keychain files closes that.
 */
export const browserIsolation = (): IsolationProfile => ({
  denyRead: [
    engineStateDir(),
    ...(process.platform === "darwin" ? [join(homedir(), "Library", "Keychains")] : []),
  ],
  shell: "sandboxed",
});

export interface SandboxProbe {
  platform: NodeJS.Platform;
  exists(path: string): boolean;
  onPath(name: string): boolean;
}

const systemProbe: SandboxProbe = {
  platform: process.platform,
  exists: existsSync,
  onPath: (name) =>
    (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, name))),
};

/**
 * Whether Claude Code's sandbox can run here. macOS uses Seatbelt. Linux needs bubblewrap and socat; the Unix-socket
 * seccomp filter ships inside the native `claude` binary, which is the only build this host resolves. Windows has none.
 */
export function sandboxStatus(probe: SandboxProbe = systemProbe): SandboxStatus {
  const unavailable = (reason: string): SandboxStatus => ({ status: "unavailable", reason });
  switch (probe.platform) {
    case "darwin":
      return probe.exists("/usr/bin/sandbox-exec")
        ? { status: "available" }
        : unavailable("the macOS sandbox (sandbox-exec) is missing");
    case "linux": {
      const missing = ["bwrap", "socat"].filter((n) => !probe.onPath(n));
      return missing.length
        ? unavailable(`the shell sandbox needs ${missing.join(" and ")} installed`)
        : { status: "available" };
    }
    default:
      return unavailable(`the shell sandbox is not supported on ${probe.platform}`);
  }
}
