import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { eventTokenSecretName, type SecretStore } from "../platform/secrets.ts";

const digest = (token: string) => createHash("sha256").update(token).digest();

/**
 * Each bot's event token, kept in the secrets backend: the host needs the plaintext to put in a harness process's
 * environment, so a digest is not enough. A token is made the first time something asks for it and only then. Tokens
 * are also held in memory, so checking a post does not read the backend again.
 */
export function createEventTokens(secrets: SecretStore) {
  const cache = new Map<string, string>();
  const last = new Map<string, Promise<unknown>>();

  /** Runs `fn` after every earlier operation on this bot's token, so a lazy create never overwrites a rotation. */
  function serial<T>(botId: string, fn: () => Promise<T>): Promise<T> {
    const run = (last.get(botId) ?? Promise.resolve()).then(fn);
    const settled = run.catch(() => undefined);
    last.set(botId, settled);
    void settled.then(() => {
      if (last.get(botId) === settled) last.delete(botId);
    });
    return run;
  }

  /** The stored token, read into the cache; `undefined` when the bot has none. */
  async function stored(botId: string): Promise<string | undefined> {
    const token = cache.get(botId) ?? (await secrets.get(eventTokenSecretName(botId))) ?? undefined;
    if (token !== undefined) cache.set(botId, token);
    return token;
  }

  async function make(botId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await secrets.set(eventTokenSecretName(botId), token);
    cache.set(botId, token);
    return token;
  }

  return {
    /** The bot's token, made if it has none. */
    get: (botId: string) => serial(botId, async () => (await stored(botId)) ?? (await make(botId))),
    /** Replaces the bot's token; the old one fails from the moment this resolves. */
    rotate: (botId: string) => serial(botId, () => make(botId)),
    /** Whether `presented` is the bot's token. A bot without one matches nothing, and none is made. */
    async matches(botId: string, presented: string): Promise<boolean> {
      const token = await stored(botId);
      return token !== undefined && timingSafeEqual(digest(token), digest(presented));
    },
    remove: (botId: string) =>
      serial(botId, async () => {
        await secrets.delete(eventTokenSecretName(botId));
        cache.delete(botId);
      }),
  };
}
