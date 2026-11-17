import type { Waits } from "../waits/index.ts";
import type { BrowserEndpoint } from "./endpoint.ts";
import type { BrowserRuntimes } from "./runtime.ts";
import type { Takeover } from "./takeover.ts";

/**
 * Everything the browser feature holds for a bot that is being deleted: its tokens stop working, its browser
 * closes with saved logins deleted, and its human waits are cancelled (any takeover ends) and their rows deleted. `HostServer.removeBot` calls this.
 */
export async function removeBotBrowser(
  deps: {
    endpoint: BrowserEndpoint;
    runtimes: BrowserRuntimes;
    takeover: Takeover;
    waits: Waits;
  },
  botId: string,
): Promise<void> {
  deps.endpoint.revokeBot(botId);
  deps.takeover.cancelBot(botId, "the bot was deleted");
  deps.waits.removeBot(botId);
  await deps.runtimes.remove(botId);
}
