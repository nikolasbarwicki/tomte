/** One JSON-serializable secret blob per integration; the real store is the OS keychain. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const SERVICE = "tomte";

/** On Windows a roaming profile would copy the default entry to other computers; `local` keeps it on this one. */
const PERSIST = process.platform === "win32" ? ({ persist: "local" } as const) : {};

export const keychainSecrets: SecretStore = {
  get: (name) => Bun.secrets.get({ service: SERVICE, name }),
  set: (name, value) => Bun.secrets.set({ service: SERVICE, name, value, ...PERSIST }),
  delete: async (name) => void (await Bun.secrets.delete({ service: SERVICE, name })),
};

export function memorySecrets(): SecretStore & { entries: ReadonlyMap<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (name) => entries.get(name) ?? null,
    set: async (name, value) => void entries.set(name, value),
    delete: async (name) => void entries.delete(name),
  };
}

export const secretName = (integrationId: string) => `integration:${integrationId}`;

export const credentialSecretName = (entryId: string) => `browser-credential:${entryId}`;

export const eventTokenSecretName = (botId: string) => `events-token:${botId}`;

/** The bot token of a channel (`telegram`), held like the event tokens: only in the secrets backend. */
export const channelTokenSecretName = (kind: string) => `channel-token:${kind}`;
