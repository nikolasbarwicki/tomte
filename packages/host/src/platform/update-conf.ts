import { isAbsolute } from "node:path";

import { z } from "zod";

/** Where `install.sh` writes the helper's configuration; root-owned, so the service user cannot choose a repository or a key. */
export const DEFAULT_CONF_PATH = "/etc/tomte/update.conf";

const DEFAULT_STATE_DIR = "/var/lib/tomte-update";

const absolute = z.string().refine(isAbsolute, "expected an absolute path");
const unitName = z.string().regex(/^[A-Za-z0-9_.@-]+$/);

/** Everything the helper takes from the machine's owner and not from the request. */
export const UpdateConf = z.object({
  /** `OWNER/REPO` whose GitHub Releases hold the host binaries. */
  repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
  /** Base64 of the 32 raw bytes of the Ed25519 key that signs every release's `SHA256SUMS`; `install.sh` writes its pinned copy. */
  publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  /** The service's data root: where `updates/request.json`, `updates/result.json`, the snapshots and `tomte.db` are. */
  dataRoot: absolute,
  /** The systemd unit name without `.service`. */
  service: unitName,
  /** The unprivileged user the service runs as; the helper writes the result and restores the database as this user. */
  serviceUser: unitName,
  /** The installed host binary; the previous one is kept next to it as `<bin>.prev`. */
  bin: absolute,
  /** The service's `EnvironmentFile`, read for the address the client listener binds. */
  envFile: absolute,
  /** Where release downloads come from, as `{base}/{repo}/releases/download/v{version}/{asset}`. */
  releaseBaseUrl: z.url(),
  /** The helper's own root-owned directory: the lock, the journal and the downloads. */
  stateDir: absolute.default(DEFAULT_STATE_DIR),
});
export type UpdateConf = z.infer<typeof UpdateConf>;

const KEYS: Record<string, keyof UpdateConf> = {
  REPO: "repo",
  PUBLIC_KEY: "publicKey",
  DATA_ROOT: "dataRoot",
  SERVICE: "service",
  SERVICE_USER: "serviceUser",
  BIN: "bin",
  ENV_FILE: "envFile",
  RELEASE_BASE_URL: "releaseBaseUrl",
  STATE_DIR: "stateDir",
};

/** The configuration file is not what the helper can safely act on; the message says what is wrong. */
export class InvalidUpdateConf extends Error {}

/** Parses `KEY=value` lines (blank lines and `#` comments allowed; no quoting, no expansion). An unknown or repeated key is an error. */
export function parseUpdateConf(text: string): UpdateConf {
  const found: Partial<Record<keyof UpdateConf, string>> = {};
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq < 0 ? undefined : KEYS[line.slice(0, eq)];
    if (key === undefined) throw new InvalidUpdateConf(`line ${i + 1}: unknown setting`);
    if (key in found)
      throw new InvalidUpdateConf(`line ${i + 1}: ${line.slice(0, eq)} is set twice`);
    found[key] = line.slice(eq + 1);
  }
  const parsed = UpdateConf.safeParse(found);
  if (!parsed.success)
    throw new InvalidUpdateConf(
      parsed.error.issues.map((e) => `${e.path.join(".") || "conf"}: ${e.message}`).join("; "),
    );
  return parsed.data;
}

const BIND_ALL: Record<string, string> = { "0.0.0.0": "127.0.0.1", "::": "[::1]", "[::]": "[::1]" };

/** The loopback `host-info` URL of the client listener `envText` (the service's `EnvironmentFile`) configures; `install.sh`'s defaults when it sets none. */
export function hostInfoUrl(envText: string): string {
  const value = (key: string) => {
    const matches = envText.split("\n").filter((l) => l.startsWith(`${key}=`));
    return matches
      .at(-1)
      ?.slice(key.length + 1)
      .trim();
  };
  const host = value("TOMTE_HOST") || "127.0.0.1";
  const port = value("TOMTE_PORT") || "8417";
  const address =
    BIND_ALL[host] ?? (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);
  return `http://${address}:${port}/api/host-info`;
}
