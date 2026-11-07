import { join } from "node:path";

import { otherBotDirs } from "../bots/index.ts";
import { browserIsolation, type SandboxStatus } from "../browser/index.ts";
import { claudeConfigDir, type HostServersSource } from "../harness/index.ts";
import type { HostConfig } from "../platform/config.ts";
import { dbFiles } from "../platform/db.ts";
import { SECRETS_FILE } from "../platform/file-secrets.ts";

/**
 * The shell isolation every bot runs under when `config.isolateAllBots` is set, as a lease with no servers (it merges with
 * the other leases in `combineLeases`); an empty lease otherwise. A bot's shell and Read tool may not read the host's state:
 * the database, the secrets file and key, the Claude sign-in, the browser engine's state and every other bot's directory.
 * The list is read on every launch, so a bot created later reaches the open sessions through `chats.reconfigure`.
 * When the sandbox cannot run, the profile disables the bot's shell instead of leaving it unconfined (ADR-0001).
 */
export function createHostIsolation(o: {
  config: HostConfig;
  sandbox: () => SandboxStatus;
}): HostServersSource {
  const { config } = o;
  let warned = false;
  return (botId) => {
    if (!config.isolateAllBots) return { servers: [], release() {} };
    const sandbox = o.sandbox();
    if (sandbox.status === "unavailable" && !warned)
      console.error(
        `[host] shell commands are disabled for every bot until the sandbox can run: ${sandbox.reason}`,
      );
    warned = sandbox.status === "unavailable";
    return {
      servers: [],
      isolation: {
        denyRead: [
          ...dbFiles(config.dataRoot),
          join(config.dataRoot, SECRETS_FILE),
          ...(config.secrets.backend === "file" ? [config.secrets.keyFile] : []),
          claudeConfigDir(config),
          ...browserIsolation().denyRead,
          ...otherBotDirs(config.dataRoot, botId),
        ],
        shell: sandbox.status === "available" ? "sandboxed" : "disabled",
      },
      release() {},
    };
  };
}
