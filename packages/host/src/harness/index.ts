import { randomUUID } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig, Options, SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";

import { GATEWAY_TOKEN_ENV } from "./claude-access.ts";

export {
  BILLING_ENV,
  VERSION,
  adoptClaudeConfigDir,
  claudeConfigDir,
  createClaudeAccess,
  isAuthFailure,
  remoteLoginCommand,
  type ClaudeAccess,
} from "./claude-access.ts";
export { authCommand, installManagedCli, isMusl, resolveCli, type ResolvedCli } from "./cli.ts";
export { spawnOptions } from "./spawn.ts";

/** An HTTP MCP server owned by the host; the token travels as a bearer header, never in argv. */
interface HostMcpServer {
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
  isolation?: IsolationProfile | undefined;
  release: () => void;
}

/** Leases the host servers a bot may use; the lease is empty when the bot has none. */
export type HostServersSource = (botId: string) => HostServerLease;

/**
 * One lease holding every server of `leases`, their instructions joined and their isolation profiles merged: the union of
 * what they deny, and a disabled shell when any of them disables it. Releasing it releases them all.
 */
export function combineLeases(leases: HostServerLease[]): HostServerLease {
  const instructions = leases.flatMap((l) => (l.instructions ? [l.instructions] : [])).join("\n\n");
  const profiles = leases.flatMap((l) => (l.isolation ? [l.isolation] : []));
  return {
    servers: leases.flatMap((l) => l.servers),
    ...(instructions && { instructions }),
    isolation: profiles.length
      ? {
          denyRead: [...new Set(profiles.flatMap((p) => p.denyRead))],
          shell: profiles.some((p) => p.shell === "disabled") ? "disabled" : "sandboxed",
        }
      : undefined,
    release: () => leases.forEach((l) => l.release()),
  };
}

/** Sandbox/isolation settings a harness renders into its launch options. */
export interface IsolationProfile {
  /** Paths the bot's shell and Read tool must not read; the CLI process itself is not affected. */
  denyRead: string[];
  /**
   * `sandboxed`: the bot's shell commands run in the CLI's sandbox (public outbound traffic only: no loopback, no Unix
   * sockets, no keychain service) and the CLI stops rather than run them unconfined. `disabled`: the sandbox cannot run
   * here, so the bot gets no shell tools at all; its shell is never unconfined.
   */
  shell: "sandboxed" | "disabled";
}

/** The Claude Code tools that run a shell command, or start or stop one in the background. */
const SHELL_TOOLS = ["Bash", "PowerShell", "Monitor", "TaskStop"];

/** What `TaskStop` stops: a background shell, or a background agent, which a background-tasks session needs even with no shell. */
const TASK_STOP = "TaskStop";

/** The deny rules that keep the Read tool out of `path`, whether it is a file or a directory. */
const readDenies = (path: string) => [`Read(/${path})`, `Read(/${path}/**)`];

/** What a harness launches with from the bot's integrations: their MCP servers, disallowed tools and plugins. */
interface LaunchIntegrations {
  mcpServers: Record<string, McpServerConfig>;
  disallowedTools: string[];
  plugins: SdkPluginConfig[];
}

interface HarnessLaunchInput {
  hostServers: HostMcpServer[];
  /** Integration servers, disallowed tools and plugins for this session. */
  integrations?: LaunchIntegrations | undefined;
  systemPromptAppend: string;
  /** How the bot's shell is confined; absent for an unconfined bot. */
  isolation?: IsolationProfile | undefined;
  /**
   * True for a session whose agents run in the background (the background-tasks front): `TaskStop` stops those, so it stays
   * available when the shell is disabled.
   */
  stopsAgents?: boolean;
}

interface HarnessLaunch {
  options: Partial<Options>;
  /** Removes any temporary files; safe to call once the CLI has read its configuration. */
  dispose(): void;
}

export interface Harness {
  launch(input: HarnessLaunchInput): HarnessLaunch;
}

const APP_PREFIX = "tomte";

export const claudeHarness: Harness = {
  launch({ hostServers, integrations, systemPromptAppend, isolation, stopsAgents }) {
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
        settingSources: [],
        extraArgs,
        disallowedTools: [
          ...(integrations?.disallowedTools ?? []),
          ...(isolation?.denyRead.flatMap(readDenies) ?? []),
          ...(isolation?.shell === "disabled"
            ? SHELL_TOOLS.filter((t) => !(stopsAgents && t === TASK_STOP))
            : []),
        ],
        ...(isolation?.shell === "sandboxed"
          ? {
              sandbox: {
                enabled: true,
                failIfUnavailable: true,
                allowUnsandboxedCommands: false,
                network: { allowedDomains: ["*"] },
                filesystem: { denyRead: isolation.denyRead },
                // The CLI keeps the custom provider's token for its own API calls; its shell commands run without it.
                credentials: {
                  envVars: GATEWAY_TOKEN_ENV.map((name) => ({ name, mode: "deny" as const })),
                },
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
