import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConnectionError } from "./connection-error.ts";
import { createConnections, type Connections, type ProfileView } from "./connections.ts";
import type { HostClient } from "./host-api.ts";
import { createProfileStore, LOCAL_ID, type ProfileStore } from "./profile-store.ts";
import type { HostState } from "./supervisor.ts";

const LOCAL = { clientUrl: "http://127.0.0.1:4100/", token: "local-token" };
const running = (clientUrl = LOCAL.clientUrl, token = LOCAL.token): HostState => ({
  status: "running",
  sidecar: { clientUrl, token, exited: new Promise(() => {}), stop: async () => {} },
});
const WORK = "https://work.example.com";
const HOME = "https://home.example.com";

interface World {
  connections: Connections;
  store: ProfileStore;
  /** Every window/session effect, in order. */
  log: string[];
  /** Origins the fake host client answers for; others are unreachable. */
  hosts: Map<
    string,
    { apiVersionError?: string; revoke?: "revoked" | "already-revoked" | "down"; pair?: string }
  >;
  vaultAvailable: { value: boolean };
  /** The local host state, which the controller reads at every use. */
  local: { state: HostState };
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "desktop-connections-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const vaultAvailable = { value: true };
  const store = createProfileStore(dir, {
    async assertAvailable() {
      if (!vaultAvailable.value) throw new ConnectionError("no credential store");
    },
    async encrypt(plain) {
      return `enc:${plain}`;
    },
    async decrypt(encrypted) {
      return encrypted.slice(4);
    },
  });
  const log: string[] = [];
  const hosts: World["hosts"] = new Map();
  let paired = 0;
  const host: HostClient = {
    async checkHost(origin) {
      const entry = hosts.get(origin);
      if (!entry) throw new ConnectionError(`Could not reach the host at ${origin}: down`);
      if (entry.apiVersionError) throw new ConnectionError(entry.apiVersionError);
      log.push(`check ${origin}`);
      return {
        version: "1",
        apiVersion: 1,
        mode: "remote",
        capabilities: { reveal: false, headedBrowser: false, browserSandbox: false },
      };
    },
    async pair(origin, code) {
      const entry = hosts.get(origin);
      if (entry?.pair !== undefined && code !== entry.pair)
        throw new ConnectionError("The host refused the pairing: invalid pairing code");
      paired += 1;
      return { deviceId: `device-${paired}`, token: `token-${paired}` };
    },
    async revoke(origin, token, deviceId) {
      const mode = hosts.get(origin)?.revoke ?? "down";
      log.push(`revoke ${origin} ${deviceId} ${token}`);
      if (mode === "down") throw new ConnectionError(`Could not reach the host at ${origin}: down`);
      return mode;
    },
  };
  const local = { state: running() };
  const connections = createConnections({
    store,
    host,
    local: () => local.state,
    async showNotRunning(state) {
      log.push(`notRunning ${state.status}`);
    },
    deviceName: "mac (desktop)",
    async signIn(url, token) {
      log.push(`signIn ${url} ${token}`);
    },
    async load(url) {
      log.push(`load ${url}`);
    },
    async clearOrigin(origin) {
      log.push(`clear ${origin}`);
    },
  });
  return { connections, store, log, hosts, vaultAvailable, local };
}

const cleanup: (() => void)[] = [];
let w: World;
beforeEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  w = world();
  w.hosts.set(WORK, { revoke: "revoked", pair: "CODE" });
  w.hosts.set(HOME, { revoke: "revoked" });
});

const add = (url = WORK, code = "CODE", name = "Work") => w.connections.add({ name, url, code });
const names = (views: ProfileView[]) => views.map((v) => `${v.name}${v.active ? "*" : ""}`);

describe("add", () => {
  test("pairs, stores the profile and signs nothing in", async () => {
    const added = await add();
    expect(added).toMatchObject({ name: "Work", origin: WORK, active: false });
    expect(names(await w.connections.list())).toEqual(["This computer*", "Work"]);
    expect(await w.store.token(added.id)).toBe("token-1");
    expect(w.log).toEqual([`check ${WORK}`]);
  });

  test("refuses a bad URL before any request", async () => {
    await expect(add("http://work.example.com")).rejects.toThrow(/Plain http/);
    await expect(add("https://work.example.com/x")).rejects.toThrow(ConnectionError);
    expect(w.log).toEqual([]);
  });

  test("shows the host's error for a wrong code and stores nothing", async () => {
    await expect(add(WORK, "WRONG")).rejects.toThrow("invalid pairing code");
    expect((await w.store.read()).profiles).toEqual([]);
  });

  test("stores nothing and pairs nothing on a version mismatch", async () => {
    w.hosts.set(WORK, { apiVersionError: "Update the host." });
    await expect(add()).rejects.toThrow("Update the host.");
    expect((await w.store.read()).profiles).toEqual([]);
  });

  test("refuses before pairing when tokens cannot be stored safely", async () => {
    w.vaultAvailable.value = false;
    await expect(add()).rejects.toThrow("no credential store");
    expect(w.log).toEqual([]);
  });

  test("refuses a missing name or code, this computer's own origin and a duplicate", async () => {
    await expect(add(WORK, "CODE", "  ")).rejects.toThrow(/name/);
    await expect(add(WORK, "  ")).rejects.toThrow(/pairing code/);
    await expect(add("http://127.0.0.1:4100")).rejects.toThrow(/this computer/);
    await add();
    await expect(add(WORK)).rejects.toThrow(/already added as "Work"/);
  });
});

describe("connect", () => {
  test("checks the version, signs in, loads the origin and remembers the choice", async () => {
    const { id } = await add();
    w.log.length = 0;
    await w.connections.connect(id);
    expect(w.log).toEqual([`check ${WORK}`, `signIn ${WORK} token-1`, `load ${WORK}`]);
    expect(names(await w.connections.list())).toEqual(["This computer", "Work*"]);
    expect((await w.store.read()).active).toBe(id);
  });

  test("switching back to local reloads the sidecar's client URL", async () => {
    const { id } = await add();
    await w.connections.connect(id);
    w.log.length = 0;
    await w.connections.connect(LOCAL_ID);
    expect(w.log).toEqual([`signIn ${LOCAL.clientUrl} local-token`, `load ${LOCAL.clientUrl}`]);
    expect((await w.store.read()).active).toBe(LOCAL_ID);
  });

  test("a version mismatch changes nothing: no sign-in, no load, same active profile", async () => {
    const { id } = await add();
    await w.connections.connect(LOCAL_ID);
    w.hosts.set(WORK, { apiVersionError: "Update the desktop app." });
    w.log.length = 0;
    await expect(w.connections.connect(id)).rejects.toThrow("Update the desktop app.");
    expect(w.log).toEqual([`signIn ${LOCAL.clientUrl} local-token`, `load ${LOCAL.clientUrl}`]);
    expect(names(await w.connections.list())).toEqual(["This computer*", "Work"]);
  });

  test("puts the window back when loading fails halfway", async () => {
    const { id } = await add();
    const failing = createConnections({
      store: w.store,
      host: {
        checkHost: async () => ({}) as never,
        pair: async () => ({}) as never,
        revoke: async () => "revoked",
      },
      local: () => running(),
      showNotRunning: async () => {},
      deviceName: "x",
      signIn: async () => {},
      load: async (url) => {
        if (url === WORK) throw new Error("ERR_CONNECTION_REFUSED");
      },
      clearOrigin: async () => {},
    });
    await expect(failing.connect(id)).rejects.toThrow("ERR_CONNECTION_REFUSED");
    expect(names(await failing.list())).toEqual(["This computer*", "Work"]);
    expect((await w.store.read()).active).toBe(LOCAL_ID);
  });
});

describe("forget", () => {
  test("revokes with the stored token, then deletes the profile and clears its origin", async () => {
    const { id } = await add();
    w.log.length = 0;
    expect(await w.connections.forget(id)).toBe("forgotten");
    expect(w.log).toEqual([
      `revoke ${WORK} device-1 token-1`,
      `clear ${WORK}`,
      `signIn ${LOCAL.clientUrl} local-token`,
    ]);
    expect((await w.store.read()).profiles).toEqual([]);
  });

  test("treats an already-revoked device as forgotten", async () => {
    w.hosts.set(WORK, { revoke: "already-revoked" });
    const { id } = await add();
    expect(await w.connections.forget(id)).toBe("forgotten");
  });

  test("forgetting the active profile switches to local and saves that", async () => {
    const { id } = await add();
    await w.connections.connect(id);
    w.log.length = 0;
    await w.connections.forget(id);
    expect(w.log.slice(-2)).toEqual([
      `signIn ${LOCAL.clientUrl} local-token`,
      `load ${LOCAL.clientUrl}`,
    ]);
    expect(names(await w.connections.list())).toEqual(["This computer*"]);
    expect((await w.store.read()).active).toBe(LOCAL_ID);
  });

  test("an unreachable host keeps the profile until the user forgets it without revoking", async () => {
    w.hosts.set(WORK, { revoke: "down" });
    const { id } = await add();
    const result = await w.connections.forget(id);
    expect(result).toMatchObject({ unreachable: expect.stringContaining("Could not reach") });
    expect((await w.store.read()).profiles).toHaveLength(1);
    w.log.length = 0;
    expect(await w.connections.forget(id, { withoutRevoking: true })).toBe("forgotten");
    expect(w.log.some((l) => l.startsWith("revoke"))).toBe(false);
    expect((await w.store.read()).profiles).toEqual([]);
  });

  test("forgetting another profile signs the shown one in again, as the cleared cookie may be shared", async () => {
    const work = await add();
    const home = await add(HOME, "x", "Home");
    await w.connections.connect(home.id);
    w.log.length = 0;
    await w.connections.forget(work.id);
    expect(w.log.slice(-2)).toEqual([`clear ${WORK}`, `signIn ${HOME} token-2`]);
  });

  test("this computer cannot be forgotten", async () => {
    await expect(w.connections.forget(LOCAL_ID)).rejects.toThrow(ConnectionError);
  });
});

describe("start", () => {
  test("opens this computer when nothing else is saved", async () => {
    expect(await w.connections.start()).toBeUndefined();
    expect(w.log).toEqual([`signIn ${LOCAL.clientUrl} local-token`, `load ${LOCAL.clientUrl}`]);
  });

  test("reconnects to the saved active profile", async () => {
    const { id } = await add();
    await w.connections.connect(id);
    const next = createConnections({ ...restart(), store: w.store });
    expect(await next.start()).toBeUndefined();
    expect(names(await next.list())).toEqual(["This computer", "Work*"]);
  });

  test("falls back to this computer with a message, keeping the saved choice", async () => {
    const { id } = await add();
    await w.connections.connect(id);
    w.hosts.delete(WORK);
    const message = await createConnections({ ...restart(), store: w.store }).start();
    expect(message).toContain('Could not connect to "Work"');
    expect(message).toContain("Showing This computer instead.");
    expect((await w.store.read()).active).toBe(id);
  });

  /** The dependencies of a fresh app launch on the same store and fake hosts. */
  function restart() {
    return {
      host: {
        checkHost: async (origin: string) => {
          if (!w.hosts.has(origin))
            throw new ConnectionError(`Could not reach the host at ${origin}: down.`);
          return {} as never;
        },
        pair: async () => ({}) as never,
        revoke: async () => "revoked" as const,
      },
      local: () => running(),
      showNotRunning: async () => {},
      deviceName: "x",
      signIn: async () => {},
      load: async () => {},
      clearOrigin: async () => {},
    };
  }
});

describe("the local host changes", () => {
  const restarted = running("http://127.0.0.1:4200/", "new-token");

  test("shown: signs in again with the new token and loads the new client URL", async () => {
    w.local.state = restarted;
    w.log.length = 0;
    await w.connections.localChanged();
    expect(w.log).toEqual([
      "signIn http://127.0.0.1:4200/ new-token",
      "load http://127.0.0.1:4200/",
    ]);
  });

  test("shown while stopped or starting: the window shows that, and the list has no origin", async () => {
    w.local.state = { status: "stopped", reason: "boom" };
    w.log.length = 0;
    await w.connections.localChanged();
    expect(w.log).toEqual(["notRunning stopped"]);
    expect((await w.connections.list())[0]).toMatchObject({
      id: LOCAL_ID,
      origin: "",
      active: true,
    });
  });

  test("not shown: a remote profile stays untouched while the local host stops and restarts", async () => {
    const { id } = await add();
    await w.connections.connect(id);
    w.local.state = { status: "starting" };
    w.log.length = 0;
    await w.connections.localChanged();
    w.local.state = restarted;
    await w.connections.localChanged();
    expect(w.log).toEqual([]);
    expect(names(await w.connections.list())).toEqual(["This computer", "Work*"]);
  });

  test("switching to local while it is stopped shows that and makes local the saved choice", async () => {
    const { id } = await add();
    await w.connections.connect(id);
    w.local.state = { status: "stopped", reason: "boom" };
    w.log.length = 0;
    await w.connections.connect(LOCAL_ID);
    expect(w.log).toEqual(["notRunning stopped"]);
    expect((await w.store.read()).active).toBe(LOCAL_ID);
  });

  test("a restarted host's origin can then be added as a profile only if it is not the local one", async () => {
    w.local.state = restarted;
    await expect(add("http://127.0.0.1:4200")).rejects.toThrow(/this computer's own host/);
  });

  test("a change reaches the listeners", async () => {
    let calls = 0;
    w.connections.onChange(() => (calls += 1));
    await w.connections.localChanged();
    expect(calls).toBe(1);
  });
});
