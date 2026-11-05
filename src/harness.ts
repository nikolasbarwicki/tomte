import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionIntegrations } from "./integrations.ts";

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
  release(): void;
}

/** Leases the host servers a bot may use; the lease is empty when the bot has none. */
export type HostServersSource = (botId: string) => HostServerLease;

/** Sandbox/isolation settings a harness renders into its launch options. Empty until a ticket fills it in. */
export interface IsolationProfile {}

export interface HarnessLaunchInput {
  hostServers: HostMcpServer[];
  /** Integration servers, disallowed tools and plugins for this session. */
  integrations?: SessionIntegrations;
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
  launch({ hostServers, integrations, systemPromptAppend }) {
    const mcpServers: Record<string, McpServerConfig> = { ...integrations?.mcpServers };
    for (const s of hostServers) {
      mcpServers[s.name] = { type: "http", url: s.url, headers: { Authorization: `Bearer ${s.token}` } };
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
        disallowedTools: integrations?.disallowedTools ?? [],
        ...(integrations?.plugins.length ? { plugins: integrations.plugins } : {}),
      },
      dispose: () => {
        if (mcpFile) rmSync(mcpFile, { force: true });
      },
    };
  },
};
