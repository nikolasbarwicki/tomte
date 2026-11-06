import { randomUUID } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig, Options, SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";

export {
  authCommand,
  cmdExeSpawner,
  installManagedCli,
  isMusl,
  loginShellPath,
  resolveCli,
  type ResolvedCli,
} from "./cli.ts";

/** An HTTP MCP server owned by the host; the token travels as a bearer header, never in argv. */
export interface HostMcpServer {
  name: string;
  url: string;
  token: string;
}

/** The host servers one live harness session may use; `release` revokes their tokens when the session closes. */
export interface HostServerLease {
  servers: HostMcpServer[];
  /** Guidance for the bot about these servers, appended to its system prompt. */
  instructions?: string;
  /** How the CLI must confine the bot shell while this lease is held; absent for an unconfined bot. */
  isolation?: IsolationProfile;
  release: () => void;
}

/** Leases the host servers a bot may use; the lease is empty when the bot has none. */
export type HostServersSource = (botId: string) => HostServerLease;

/** One lease holding every server of `leases`, their instructions joined and the first isolation profile; releasing it releases them all. */
export function combineLeases(leases: HostServerLease[]): HostServerLease {
  const instructions = leases.flatMap((l) => (l.instructions ? [l.instructions] : [])).join("\n\n");
  return {
    servers: leases.flatMap((l) => l.servers),
    ...(instructions && { instructions }),
    isolation: leases.find((l) => l.isolation)?.isolation,
    release: () => leases.forEach((l) => l.release()),
  };
}

/** Sandbox/isolation settings a harness renders into its launch options. */
export interface IsolationProfile {
  /**
   * Confines the bot's shell commands: public outbound traffic only (no loopback, no Unix sockets, no keychain
   * service), and these paths unreadable by the shell and the Read tool. Absent means today's unconfined behaviour.
   */
  shell?: { denyRead: string[] };
}

/** What a harness launches with from the bot's integrations: their MCP servers, disallowed tools and plugins. */
export interface LaunchIntegrations {
  mcpServers: Record<string, McpServerConfig>;
  disallowedTools: string[];
  plugins: SdkPluginConfig[];
}

export interface HarnessLaunchInput {
  hostServers: HostMcpServer[];
  /** Integration servers, disallowed tools and plugins for this session. */
  integrations?: LaunchIntegrations;
  systemPromptAppend: string;
  isolation: IsolationProfile;
}

export interface HarnessLaunch {
  options: Partial<Options>;
  /** Removes any temporary files; safe to call once the CLI has read its configuration. */
  dispose(): void;
}

export interface Harness {
  launch(input: HarnessLaunchInput): HarnessLaunch;
}

const APP_PREFIX = "claudebot";

export const claudeHarness: Harness = {
  launch({ hostServers, integrations, systemPromptAppend, isolation }) {
    const mcpServers: Record<string, McpServerConfig> = { ...integrations?.mcpServers };
    for (const s of hostServers) {
      mcpServers[s.name] = {
        type: "http",
        url: s.url,
        headers: { Authorization: `Bearer ${s.token}` },
      };
    }
    const extraArgs: Record<string, string | null> = {};
    let mcpFile: string | undefined;
    if (Object.keys(mcpServers).length) {
      mcpFile = join(tmpdir(), `${APP_PREFIX}-mcp-${randomUUID()}.json`);
      writeFileSync(mcpFile, JSON.stringify({ mcpServers }), { mode: 0o600 });
      chmodSync(mcpFile, 0o600);
      extraArgs["mcp-config"] = mcpFile;
    }
    return {
      options: {
        systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend },
        permissionMode: "default",
        strictMcpConfig: true,
        settingSources: ["user"],
        extraArgs,
        disallowedTools: [
          ...(integrations?.disallowedTools ?? []),
          ...(isolation.shell?.denyRead.map((p) => `Read(/${p}/**)`) ?? []),
        ],
        ...(isolation.shell
          ? {
              sandbox: {
                enabled: true,
                failIfUnavailable: true,
                allowUnsandboxedCommands: false,
                network: { allowedDomains: ["*"] },
                filesystem: { denyRead: isolation.shell.denyRead },
              },
            }
          : {}),
        ...(integrations?.plugins.length ? { plugins: integrations.plugins } : {}),
      },
      dispose: () => {
        if (mcpFile) rmSync(mcpFile, { force: true });
      },
    };
  },
};
