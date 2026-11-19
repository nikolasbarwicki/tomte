import type { BuiltinService } from "@tomte/contract/events";

import { createGmailServer, prepareGmailApproval } from "./gmail/server.ts";
import type { ApprovalInput } from "./gmail/tool.ts";
import { GMAIL_TOOLS } from "./gmail/tools.ts";
import type { DiscoveredTool } from "./store.ts";
import { VERBS, type VerbClass } from "./verbs.ts";

/**
 * What a built-in integration's server is given: where its provider's API is, how to authenticate a request (a rejected token asks
 * for a new one), what to call when only a new sign-in can fix a failure, and where to log.
 */
export interface BuiltinServerDeps {
  apiBase: string;
  accessToken: (rejected?: string) => Promise<string>;
  signInLost: () => Promise<void>;
  /** The bot's files folder, where a tool saves a file for the bot; absent when the session has none. */
  filesDir?: string | undefined;
  log: (line: string) => void;
}

/** One built-in service: its tools, which are its whole definition, and how to build a fresh in-process server for a session. */
const SERVICES = {
  gmail: { tools: GMAIL_TOOLS, server: createGmailServer, prepare: prepareGmailApproval },
} satisfies Record<
  BuiltinService,
  {
    tools: readonly { name: string; description: string; verb: VerbClass }[];
    server: (o: BuiltinServerDeps) => unknown;
    prepare: (
      o: Omit<BuiltinServerDeps, "filesDir">,
      tool: string,
      input: Record<string, unknown>,
    ) => Promise<ApprovalInput>;
  }
>;

/** `tool`'s input as the owner approves it; see `GmailTool.prepareApproval`. */
export const prepareBuiltinApproval = (
  service: BuiltinService,
  o: Omit<BuiltinServerDeps, "filesDir">,
  tool: string,
  input: Record<string, unknown>,
) => SERVICES[service].prepare(o, tool, input);

/** A fresh in-process MCP server for a built-in service; the server's name is the service's. */
export const createBuiltinServer = (service: BuiltinService, o: BuiltinServerDeps) =>
  SERVICES[service].server(o);

/** The tools a built-in service defines, as the tool store records them: the default policy and annotations follow each tool's verb class. */
export const builtinTools = (service: BuiltinService): DiscoveredTool[] =>
  SERVICES[service].tools.map((t) => ({
    name: t.name,
    description: t.description,
    readOnly: VERBS[t.verb].readOnly,
    destructive: VERBS[t.verb].destructive,
    policy: VERBS[t.verb].policy,
  }));

/**
 * The tools a built-in integration's own definition locks, as `mcp__<server>__<tool>` names. A locked tool always asks the owner:
 * its policy can never be Auto, an always-allow rule never skips its approval and its approval offers Allow and Deny only.
 * Nothing stores a lock, so a catalog or custom integration cannot have one.
 */
export const BUILTIN_LOCKED_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(SERVICES).flatMap(([service, { tools }]) =>
    tools.filter((t) => VERBS[t.verb].locked).map((t) => `mcp__${service}__${t.name}`),
  ),
);
