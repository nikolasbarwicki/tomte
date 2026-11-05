/** One JSON-serializable secret blob per integration; the real store is the OS keychain. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const SERVICE = "claudebot";

export const keychainSecrets: SecretStore = {
  get: (name) => Bun.secrets.get({ service: SERVICE, name }),
  set: (name, value) => Bun.secrets.set({ service: SERVICE, name, value }),
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
