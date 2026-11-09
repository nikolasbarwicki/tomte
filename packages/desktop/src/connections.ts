import { ConnectionError } from "./connection-error.ts";
import type { HostClient } from "./host-api.ts";
import { LOCAL_ID, type ProfileStore } from "./profile-store.ts";
import { parseProfileUrl } from "./profile-url.ts";
import type { HostState } from "./supervisor.ts";

const LOCAL_NAME = "This computer";

/** What the Connections page, the application menu and the tray show for one profile. Never carries a token. */
export interface ProfileView {
  id: string;
  name: string;
  origin: string;
  active: boolean;
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

/** What a connection's host accepts from this app: its client origin and this device's token. Never log the token. */
export interface HostCredentials {
  origin: string;
  token: string;
}

export interface Connections {
  /** `This computer` first, then the stored profiles in the order they were added. */
  list(): Promise<ProfileView[]>;
  add(input: { name: string; url: string; code: string }): Promise<ProfileView>;
  /** Version check, sign-in, load, then the choice is saved as the one to open at the next start. */
  connect(id: string): Promise<void>;
  /** Revokes this app's device on the host, then forgets the profile. With `withoutRevoking` the host is not asked. */
  forget(id: string, options?: { withoutRevoking?: boolean }): Promise<ForgetResult>;
  /** Connects to the profile saved as active. Returns a message when that failed and this computer is shown instead. */
  start(): Promise<string | undefined>;
  /** The local host's state changed (it started, stopped or restarted): when `local` is shown, shows it again as it now is. */
  localChanged(): Promise<void>;
  /** The credentials of the connection the window shows; undefined while that is this computer and its host is not running. */
  credentials(): Promise<HostCredentials | undefined>;
  /** Calls `listener` after every change to the list or the active profile. */
  onChange(listener: () => void): void;
}

/** The profiles, the one the window shows, and the operations between them. Operations run one at a time, so two clicks cannot interleave a read-modify-write of the store. */
export function createConnections(deps: ConnectionsDeps): Connections {
  const { store, host } = deps;
  const listeners: (() => void)[] = [];
  let current = LOCAL_ID;
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const changed = () => listeners.forEach((listener) => listener());

  async function show(clientUrl: string, token: string): Promise<void> {
    await deps.signIn(clientUrl, token);
    await deps.load(clientUrl);
  }

  async function showLocal(): Promise<void> {
    const state = deps.local();
    if (state.status === "running") await show(state.sidecar.clientUrl, state.sidecar.token);
    else await deps.showNotRunning(state);
    current = LOCAL_ID;
  }

  async function showProfile(id: string): Promise<void> {
    if (id === LOCAL_ID) return showLocal();
    const profile = (await store.read()).profiles.find((p) => p.id === id);
    if (!profile) throw new ConnectionError("That connection no longer exists.");
    await host.checkHost(profile.origin);
    await show(profile.origin, await store.token(id));
    current = id;
  }

  /** Puts the window back where it was after a connect that failed halfway. Best effort: the user already has an error to read. */
  async function restore(previous: string): Promise<void> {
    await showProfile(previous).catch(() => showLocal().catch(() => {}));
  }

  async function connectNow(id: string): Promise<void> {
    const previous = current;
    try {
      await showProfile(id);
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
      (p) => ({ id: p.id, name: p.name, origin: p.origin, active: p.id === current }),
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
        await host.checkHost(origin);
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

    connect: (id) => serial(() => connectNow(id)),

    forget: (id, options) => serial(() => forgetNow(id, options?.withoutRevoking ?? false)),

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

    async credentials() {
      if (current === LOCAL_ID) {
        const state = deps.local();
        return state.status === "running"
          ? { origin: new URL(state.sidecar.clientUrl).origin, token: state.sidecar.token }
          : undefined;
      }
      const profile = (await store.read()).profiles.find((p) => p.id === current);
      return profile && { origin: profile.origin, token: await store.token(profile.id) };
    },

    onChange: (listener) => void listeners.push(listener),
  };
}
