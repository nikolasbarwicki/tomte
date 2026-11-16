import type { EgressProxy } from "../egress-proxy.ts";
import type { BrowserLogin } from "../login.ts";
import type { PageState } from "../page-state.ts";
import type { BotBrowser } from "../runtime.ts";
import type { Takeover } from "../takeover.ts";

/** What every browser tool is allowed to touch: one bot's browser, nothing else. */
export interface BrowserToolContext {
  botId: string;
  browser: BotBrowser;
  /** What the bot has seen of its page: snapshot revision and repeated-call streak. */
  page: PageState;
  /** The bot's files folder, where oversized results and screenshots are saved. */
  filesDir: string;
  /** Tells a navigation tool whether the network block refused something during its call. */
  egress: Pick<EgressProxy, "blockedSince">;
  /** Asks the user to take over the bot's browser. */
  takeover: Pick<Takeover, "request">;
  /** Stored credentials and sign-in. */
  login: Pick<BrowserLogin, "list" | "login">;
}
