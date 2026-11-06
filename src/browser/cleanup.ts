import type { Credentials } from "../credentials/index.ts";
import type { BrowserEndpoint } from "./endpoint.ts";
import type { BrowserRuntimes } from "./runtime.ts";
import type { Takeover } from "./takeover.ts";

/**
 * Everything the browser feature holds for a bot that is being deleted: its tokens stop working, its browser
 * closes with saved logins deleted, its pending human waits are cancelled and any takeover ends, and its credential grants go. Claudebot has no bot-delete path yet; call this from it.
 */
export async function removeBotBrowser(deps: { endpoint: BrowserEndpoint; runtimes: BrowserRuntimes; takeover: Takeover; credentials: Credentials }, botId: string): Promise<void> {
  deps.endpoint.revokeBot(botId);
  deps.takeover.cancelBot(botId, "the bot was deleted");
  await deps.runtimes.remove(botId);
  deps.credentials.removeBot(botId);
}
