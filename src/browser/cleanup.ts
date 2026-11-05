import type { Credentials } from "../credentials.ts";
import type { BrowserEndpoint } from "./endpoint.ts";
import type { BrowserRuntimes } from "./runtime.ts";

/**
 * Everything the browser feature holds for a bot that is being deleted: its tokens stop working, its browser
 * closes with saved logins deleted, and its credential grants go. Claudebot has no bot-delete path yet; call this from it.
 */
export async function removeBotBrowser(deps: { endpoint: BrowserEndpoint; runtimes: BrowserRuntimes; credentials: Credentials }, botId: string): Promise<void> {
  deps.endpoint.revokeBot(botId);
  await deps.runtimes.remove(botId);
  deps.credentials.removeBot(botId);
}
