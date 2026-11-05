import { randomBytes } from "node:crypto";
import { resolveEngine } from "../browser-engine.ts";
import type { SecretStore } from "../secrets.ts";
import { DEFAULT_CALL_TIMEOUT_MS, EngineError, findChrome, runEngine, type EngineLaunch } from "./engine-cli.ts";

const KEY_SECRET = "browser-encryption-key";

/** The engine or Chrome is missing, so no browser call can run. */
export class BrowserUnavailable extends Error {}

export interface BrowserRuntimeOptions {
  /** Extra environment for engine processes. */
  env?: Record<string, string>;
  callTimeoutMs?: number;
}

/** One bot's browser. It has no engine session until the first call. */
export interface BotBrowser {
  /** Runs an engine command in this bot's session and returns its data; throws `EngineError` or `BrowserUnavailable`. */
  call(command: string[]): Promise<unknown>;
}

export interface BrowserRuntimes {
  forBot(botId: string): BotBrowser;
  /** Closes every browser that was started, keeping saved logins. */
  closeAll(): Promise<void>;
}

/** The engine key is generated once and lives in the secret store; it is never written to disk. */
async function engineKey(secrets: SecretStore): Promise<string> {
  const stored = await secrets.get(KEY_SECRET);
  if (stored) return stored;
  const key = randomBytes(32).toString("hex");
  await secrets.set(KEY_SECRET, key);
  return key;
}

export function createBrowserRuntimes(secrets: SecretStore, o: BrowserRuntimeOptions = {}): BrowserRuntimes {
  const started = new Set<string>();
  let key: Promise<string> | undefined;

  async function launch(): Promise<EngineLaunch> {
    const binary = resolveEngine()?.path;
    if (!binary) throw new BrowserUnavailable("the browser engine is not installed");
    const chrome = findChrome();
    if (!chrome) throw new BrowserUnavailable("Chrome for Testing is not installed; run `bun src/host.ts install-browser`");
    key ??= engineKey(secrets).catch((e) => {
      key = undefined;
      throw e;
    });
    return { binary, chrome, encryptionKey: await key, env: o.env };
  }

  const timeoutMs = o.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  async function exec(botId: string, command: string[]) {
    return runEngine(await launch(), botId, command, timeoutMs);
  }

  async function run(botId: string, command: string[]) {
    const l = await launch();
    started.add(botId);
    return runEngine(l, botId, command, timeoutMs);
  }

  return {
    forBot: (botId) => ({ call: (command) => run(botId, command) }),
    async closeAll() {
      const ids = [...started];
      started.clear();
      await Promise.all(
        ids.map((id) =>
          exec(id, ["close"]).catch((e) => {
            if (!(e instanceof EngineError || e instanceof BrowserUnavailable)) throw e;
            console.error(`[browser] closing ${id} failed: ${e.message}`);
          }),
        ),
      );
    },
  };
}
