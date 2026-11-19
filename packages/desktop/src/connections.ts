import { ConnectionError } from "./connection-error.ts";
import { shellCompat, type HostClient } from "./host-api.ts";
import { LOCAL_ID, type ProfileStore } from "./profile-store.ts";
import { parseProfileUrl } from "./profile-url.ts";
import type { HostState } from "./supervisor.ts";

const LOCAL_NAME = "This computer";

/** What to tell the user when a host's range does not overlap the app's. */
function updateAdvice(origin: string, update: "update-host" | "update-app"): string {
  return update === "update-host"
    ? `The host at ${origin} is too old for this app's connection features. Update the host.`
    : `The host at ${origin} is newer than this app's connection features understand. Update the desktop app.`;
}

/** What the Connections page, the application menu and the tray show for one profile. Never carries a token. */
export interface ProfileView {
  id: string;
  name: string;
  origin: string;
  active: boolean;
  /** Which side to update when the host's shell API range does not overlap this app's, as last seen; absent when it does, or when it has not been read. */
  update?: "update-host" | "update-app";
}

export interface ConnectionsDeps {
  store: ProfileStore;
  host: HostClient;
  /** The host the app started itself, which is the `local` profile. Read at every use: a restarted host has a new client URL and token. */
  local(): HostState;
  /** Shows the page for a local host that is starting or stopped. */
  showNotRunning(state: Exclude<HostState, { status: "running" }>): Promise<void>;
  /** The name the host's Devices page shows for this app, such as "my-mac (desktop)". */
  deviceName: string;
  /** Sets the session cookie for `clientUrl`'s origin in the window's session. */
  signIn(clientUrl: string, token: string): Promise<void>;
  /** Makes `clientUrl`'s origin the active one and loads it in the window. */
  load(clientUrl: string): Promise<void>;
  /** Removes everything the window's session stored for `origin`, cookies included. */
  clearOrigin(origin: string): Promise<void>;
}

type ForgetResult = "forgotten" | { unreachable: string };

/** A host the app follows on its event stream: its client origin and this device's token. Never log the token. */
export interface FollowTarget {
  /** `local` for this computer's host, otherwise the profile's id. */
  id: string;
  name: string;
  origin: string;
  token: string;
}

export interface Connections {
  /** `This computer` first, then the stored profiles in the order they were added. */
  list(): Promise<ProfileView[]>;
  add(input: { name: string; url: string; code: string }): Promise<ProfileView>;
  /** Reads the host's version range, signs in, loads the window (on `path` of the host when given), then the choice is saved as the one to open at the next start. */
  connect(id: string, path?: string): Promise<void>;
  /** Revokes this app's device on the host, then forgets the profile. With `withoutRevoking` the host is not asked. */
  forget(id: string, options?: { withoutRevoking?: boolean }): Promise<ForgetResult>;
  /** The profile saved as active, `local` when none is or the store cannot be read: what `start` is about to show. */
  savedActive(): Promise<string>;
  /** Connects to the profile saved as active. Returns a message when that failed and this computer is shown instead. */
  start(): Promise<string | undefined>;
  /** The local host's state changed (it started, stopped or restarted): when `local` is shown, shows it again as it now is. */
  localChanged(): Promise<void>;
  /** Every host to follow: this computer's while it runs, then every profile, whichever one the window shows. A profile whose token cannot be read is left out. */
  followTargets(): Promise<FollowTarget[]>;
  /** Calls `listener` after every change to the list or the active profile. */
  onChange(listener: () => void): void;
}

/** The profiles, the one the window shows, and the operations between them. Operations run one at a time, so two clicks cannot interleave a read-modify-write of the store. */
export function createConnections(deps: ConnectionsDeps): Connections {
  const { store, host } = deps;
  const listeners: (() => void)[] = [];
  let current = LOCAL_ID;
  /** The last verdict `shellCompat` gave each remote profile, by id. A profile read nothing from stays out. */
  const outOfRange = new Map<string, "update-host" | "update-app">();
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const changed = () => listeners.forEach((listener) => listener());

  async function show(clientUrl: string, token: string, path?: string): Promise<void> {
    await deps.signIn(clientUrl, token);
    await deps.load(path === undefined ? clientUrl : new URL(path, clientUrl).href);
  }

  async function showLocal(path?: string): Promise<void> {
    const state = deps.local();
    if (state.status === "running") await show(state.sidecar.clientUrl, state.sidecar.token, path);
    else await deps.showNotRunning(state);
    current = LOCAL_ID;
  }

  async function showProfile(id: string, path?: string): Promise<void> {
    if (id === LOCAL_ID) return showLocal(path);
    const profile = (await store.read()).profiles.find((p) => p.id === id);
    if (!profile) throw new ConnectionError("That connection no longer exists.");
    const compat = shellCompat(await host.checkHost(profile.origin));
    if (compat === "ok") outOfRange.delete(id);
    else outOfRange.set(id, compat);
    await show(profile.origin, await store.token(id), path);
    current = id;
  }

  /** Puts the window back where it was after a connect that failed halfway. Best effort: the user already has an error to read. */
  async function restore(previous: string): Promise<void> {
    await showProfile(previous).catch(() => showLocal().catch(() => {}));
  }

  async function connectNow(id: string, path?: string): Promise<void> {
    const previous = current;
    try {
      await showProfile(id, path);
    } catch (error) {
      if (current !== id) await restore(previous);
      throw error;
    }
    await store.setActive(id);
    changed();
  }

  async function view(): Promise<ProfileView[]> {
    const { profiles } = await store.read();
    return [{ id: LOCAL_ID, name: LOCAL_NAME, origin: localOrigin() ?? "" }, ...profiles].map(
      (p) => {
        const update = outOfRange.get(p.id);
        return {
          id: p.id,
          name: p.name,
          origin: p.origin,
          active: p.id === current,
          ...(update && { update }),
        };
      },
    );
  }

  /** The local host's origin while it runs. */
  function localOrigin(): string | undefined {
    const state = deps.local();
    return state.status === "running" ? new URL(state.sidecar.clientUrl).origin : undefined;
  }

  /** The active profile's cookie, set again: forgetting a profile on the same host name (two loopback ports) clears it too. */
  async function signInCurrent(): Promise<void> {
    if (current === LOCAL_ID) {
      const state = deps.local();
      if (state.status === "running")
        await deps.signIn(state.sidecar.clientUrl, state.sidecar.token);
      return;
    }
    const profile = (await store.read()).profiles.find((p) => p.id === current);
    if (profile) await deps.signIn(profile.origin, await store.token(current));
  }

  async function forgetNow(id: string, withoutRevoking: boolean): Promise<ForgetResult> {
    if (id === LOCAL_ID) throw new ConnectionError("This computer is always available.");
    const profile = (await store.read()).profiles.find((p) => p.id === id);
    if (!profile) throw new ConnectionError("That connection no longer exists.");
    if (!withoutRevoking) {
      try {
        await host.revoke(profile.origin, await store.token(id), profile.deviceId);
      } catch (error) {
        if (!(error instanceof ConnectionError)) throw error;
        return { unreachable: error.message };
      }
    }
    await store.remove(id);
    outOfRange.delete(id);
    await deps.clearOrigin(profile.origin);
    if (current === id) {
      await showLocal();
      await store.setActive(LOCAL_ID);
    } else {
      await signInCurrent();
    }
    changed();
    return "forgotten";
  }

  return {
    list: view,

    add: (input) =>
      serial(async () => {
        const name = input.name.trim();
        if (name === "" || name.length > 100)
          throw new ConnectionError("Give the connection a name of up to 100 characters.");
        const origin = parseProfileUrl(input.url);
        if (input.code.trim() === "") throw new ConnectionError("Enter the pairing code.");
        if (origin === localOrigin())
          throw new ConnectionError("That is this computer's own host, which is always listed.");
        const existing = (await store.read()).profiles.find((p) => p.origin === origin);
        if (existing)
          throw new ConnectionError(`${origin} is already added as "${existing.name}".`);
        await store.assertCanStore();
        const compat = shellCompat(await host.checkHost(origin));
        if (compat !== "ok") throw new ConnectionError(updateAdvice(origin, compat));
        const paired = await host.pair(origin, input.code.trim(), deps.deviceName);
        let stored;
        try {
          stored = await store.add({
            name,
            origin,
            deviceId: paired.deviceId,
            token: paired.token,
          });
        } catch (error) {
          // Paired but not saved: leave no valid device behind that nobody holds a token for.
          await host.revoke(origin, paired.token, paired.deviceId).catch(() => {});
          throw error;
        }
        changed();
        return { id: stored.id, name, origin, active: false };
      }),

    connect: (id, path) => serial(() => connectNow(id, path)),

    forget: (id, options) => serial(() => forgetNow(id, options?.withoutRevoking ?? false)),

    savedActive: async () => (await store.read().catch(() => undefined))?.active ?? LOCAL_ID,

    start: () =>
      serial(async () => {
        const { active, profiles } = await store
          .read()
          .catch(() => ({ active: LOCAL_ID, profiles: [] }));
        if (active !== LOCAL_ID) {
          const name = profiles.find((p) => p.id === active)?.name ?? "the saved connection";
          try {
            await showProfile(active);
            changed();
            return undefined;
          } catch (error) {
            await showLocal();
            changed();
            const reason = (error instanceof Error ? error.message : String(error)).replace(
              /\.?$/,
              ".",
            );
            return `Could not connect to "${name}": ${reason} Showing ${LOCAL_NAME} instead.`;
          }
        }
        await showLocal();
        changed();
        return undefined;
      }),

    localChanged: () =>
      serial(async () => {
        if (current === LOCAL_ID) await showLocal();
        changed();
      }),

    async followTargets() {
      const targets: FollowTarget[] = [];
      const state = deps.local();
      if (state.status === "running")
        targets.push({
          id: LOCAL_ID,
          name: LOCAL_NAME,
          origin: new URL(state.sidecar.clientUrl).origin,
          token: state.sidecar.token,
        });
      for (const { id, name, origin } of (await store.read()).profiles) {
        const token = await store.token(id).catch(() => undefined);
        if (token !== undefined) targets.push({ id, name, origin, token });
      }
      return targets;
    },

    onChange: (listener) => void listeners.push(listener),
  };
}
