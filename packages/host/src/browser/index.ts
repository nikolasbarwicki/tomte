import type { IncomingMessage, ServerResponse } from "node:http";

import type { Bot, ServerEvent } from "@claudebot/contract/events";

import type { Credentials } from "../credentials/index.ts";
import type { HostOrigin } from "../platform/config.ts";
import type { SecretStore } from "../platform/secrets.ts";
import type { TokenRegistry } from "../platform/tokens.ts";
import { removeBotBrowser } from "./cleanup.ts";
import { createEgressProxy } from "./egress-proxy.ts";
import { createBrowserEndpoint, type BrowserEndpoint } from "./endpoint.ts";
import { engineStatus, type EngineStatus } from "./engine.ts";
import { createHumanWaits, type HumanWaitsOptions } from "./human-waits.ts";
import { createLiveView, type LiveViewOptions } from "./live-view.ts";
import { CREDENTIAL_EXCHANGE_PATH, createBrowserLogin } from "./login.ts";
import { createBrowserRuntimes, type BrowserRuntimeOptions } from "./runtime.ts";
import { sandboxStatus, type SandboxStatus } from "./sandbox.ts";
import { Takeover } from "./takeover.ts";
import { createBrowserUiRoutes } from "./ui-routes.ts";

export { BROWSER_ENDPOINT_PATH, type BrowserEndpoint } from "./endpoint.ts";
export { installManagedEngine } from "./engine.ts";
export { LIVE_VIEW_PATH } from "./live-view.ts";
export { BROWSER_UI_PATHS } from "./ui-routes.ts";
export {
  CREDENTIAL_EXCHANGE_PATH,
  type BrowserRuntimeOptions,
  type LiveViewOptions,
  type SandboxStatus,
};

export interface BrowserOptions extends HumanWaitsOptions {
  /** The data root; the managed engine is installed in it. */
  dataRoot: string;
  secrets: SecretStore;
  credentials: Credentials;
  /** The host-wide token registry shared with the bots endpoint. */
  tokens: TokenRegistry;
  /** Where the host is reachable; guards name it and bots are leased URLs on it. */
  host: HostOrigin;
  bot(botId: string): Bot | undefined;
  filesDir: (botId: string) => string;
  /** True while no human is watching the bot's turn. */
  unattended: (botId: string) => boolean;
  /** Whether the shell sandbox can run; checks this platform when omitted. */
  sandbox?: () => SandboxStatus;
  /** Overrides for the browser engine, Chrome and the engine's environment. */
  runtime?: BrowserRuntimeOptions;
  /** Pacing overrides for the live view. */
  liveView?: Pick<LiveViewOptions, "maxFps" | "retryMs">;
  /** How long the user may hold a bot's browser without input before control ends. */
  takeoverInactivityMs?: number;
}

export interface Browser {
  /** The browser endpoint: the browser tools served to bot sessions. */
  endpoint: BrowserEndpoint;
  /** Serves `CREDENTIAL_EXCHANGE_PATH`. */
  handleCredentialExchange(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Serves `LIVE_VIEW_PATH`. */
  handleLiveView(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Serves the paths in `BROWSER_UI_PATHS`. */
  handleUi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
  /** Whether the browser can be switched on: the engine, Chrome and the shell sandbox must all be usable. */
  status(): EngineStatus;
  /** Wait cards still open for a bot, to replay into its chat. */
  pendingWaits: (botId: string) => ServerEvent[];
  /** Ends any takeover of a bot's browser. */
  cancelTakeover(botId: string, reason: string): void;
  restart(botId: string): Promise<void>;
  signOut(botId: string): Promise<void>;
  /** Everything the browser feature holds for a bot being deleted. */
  removeBot(botId: string): Promise<void>;
  /** Closes the live view, every browser and the egress proxy. */
  close(): Promise<void>;
}

/** Starts the egress proxy and the browser runtimes, then wires the browser feature's parts together. */
export async function createBrowser(o: BrowserOptions): Promise<Browser> {
  const enabled = (botId: string) => o.bot(botId)?.browser.enabled ?? false;
  const sandboxOf = o.sandbox ?? (() => sandboxStatus());
  const egress = createEgressProxy();
  await egress.start();
  const runtimes = createBrowserRuntimes(o.secrets, egress, o.dataRoot, {
    ...o.runtime,
    headed: (botId) => o.bot(botId)?.browser.headed ?? false,
  });
  runtimes.start();
  const waits = createHumanWaits({ emit: o.emit, deliver: o.deliver });
  const takeover = new Takeover({
    runtimes,
    waits,
    deliver: o.deliver,
    inactivityMs: o.takeoverInactivityMs,
  });
  const login = createBrowserLogin({
    credentials: o.credentials,
    secrets: o.secrets,
    waits,
    botName: (botId) => o.bot(botId)?.name ?? "A bot",
    exchangeUrl: () => `${o.host.localUrl}${CREDENTIAL_EXCHANGE_PATH}`,
  });
  const endpoint = createBrowserEndpoint({
    tokens: o.tokens,
    takeover,
    login,
    unattended: o.unattended,
    host: o.host,
    isEnabled: (botId) => enabled(botId) && sandboxOf().status === "available",
    runtimes,
    filesDir: o.filesDir,
    egress,
  });
  const liveView = createLiveView({
    ...o.liveView,
    host: o.host,
    isEnabled: enabled,
    runtimes,
    takeover,
  });
  const ui = createBrowserUiRoutes({ host: o.host, isEnabled: enabled, takeover, waits, liveView });
  return {
    endpoint,
    handleCredentialExchange: (req, res) => login.handle(req, res, o.host),
    handleLiveView: (req, res) => liveView.handle(req, res),
    handleUi: ui,
    status() {
      const engine = engineStatus(o.dataRoot);
      if (engine.status === "unavailable") return engine;
      const sandbox = sandboxOf();
      return sandbox.status === "unavailable" ? sandbox : engine;
    },
    pendingWaits: (botId) => waits.pending(botId),
    cancelTakeover: (botId, reason) => takeover.cancelBot(botId, reason),
    restart: (botId) => runtimes.restart(botId),
    signOut: (botId) => runtimes.signOut(botId),
    removeBot: (botId) =>
      removeBotBrowser({ endpoint, runtimes, takeover, credentials: o.credentials }, botId),
    async close() {
      liveView.close();
      await runtimes.closeAll();
      await egress.stop();
    },
  };
}
