import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

import { VERBS } from "../verbs.ts";
import { GmailError, createGmailApi } from "./client.ts";
import { ToolInputError, type ApprovalInput } from "./tool.ts";
import { GMAIL_TOOLS } from "./tools.ts";

type ServerDeps = {
  apiBase: string;
  accessToken: (rejected?: string) => Promise<string>;
  signInLost: () => Promise<void>;
  filesDir?: string | undefined;
  log: (line: string) => void;
};

/**
 * What a bot reads when a tool of the server fails: the reason for an input or Gmail error, a generic text for anything else. A
 * failure that only a new sign-in fixes (a rejected token, a missing scope) is also reported through `signInLost`.
 */
async function failureText(e: unknown, tool: string, o: ServerDeps): Promise<string> {
  if (e instanceof ToolInputError) return e.message;
  if (e instanceof GmailError) {
    if (e.signInLost) await o.signInLost();
    return `Gmail error (${e.status || "no answer"}): ${e.message}`;
  }
  o.log(`[gmail] ${tool} failed unexpectedly`);
  return "Gmail returned an answer this tool could not read.";
}

/**
 * The input of a call to a Gmail tool as the owner is shown it for approval: the tool's own `prepareApproval` applied (a send of a
 * draft gains the draft's content), or `input` itself. `refused` is why a call cannot be offered for approval, in words for the bot.
 */
export async function prepareGmailApproval(
  o: ServerDeps,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ApprovalInput> {
  const t = GMAIL_TOOLS.find((x) => x.name === toolName);
  if (!t?.prepareApproval) return { input };
  try {
    return {
      input: await t.prepareApproval(
        createGmailApi({ base: o.apiBase, accessToken: o.accessToken, log: o.log }),
        input,
      ),
    };
  } catch (e) {
    return { refused: await failureText(e, toolName, o) };
  }
}

/**
 * The in-process `gmail` MCP server: the Gmail REST API behind `GMAIL_TOOLS`, called with the access token `accessToken` returns per
 * request. A failure that only a new sign-in fixes (a rejected token, a missing scope) is reported through `signInLost`.
 */
export function createGmailServer(o: ServerDeps) {
  const api = createGmailApi({ base: o.apiBase, accessToken: o.accessToken, log: o.log });
  const text = (s: string, isError = false) => ({
    content: [{ type: "text" as const, text: s }],
    isError,
  });
  return createSdkMcpServer({
    name: "gmail",
    tools: GMAIL_TOOLS.map((t) =>
      tool(
        t.name,
        t.description,
        t.input,
        async (args) => {
          try {
            return text(await t.run(api, args, { filesDir: o.filesDir }));
          } catch (e) {
            return text(await failureText(e, t.name, o), true);
          }
        },
        {
          annotations: {
            readOnlyHint: VERBS[t.verb].readOnly,
            destructiveHint: VERBS[t.verb].destructive,
          },
        },
      ),
    ),
  });
}
