import type { Sidecar } from "./sidecar.ts";

/** What the tray shows. `stopped` carries the reason, which is fit to show the user; `paused` is a host the app stopped on purpose and starts again when it is wanted (nothing is deleted). */
export type HostState =
  | { status: "starting" }
  | { status: "running"; sidecar: Sidecar }
  | { status: "paused" }
  | { status: "stopped"; reason: string };

export interface Supervisor {
  state(): HostState;
  /** Called on every change of state, never for the state it was added in. Returns a function that removes it. */
  onChange(listener: (state: HostState) => void): () => void;
  /**
   * Makes the host run (`true`: launch it unless it is starting or running) or pause (`false`: end a running host, and
   * turn a stopped one, or one never started, into `paused` without launching anything). Calls run one after another,
   * so the latest wish wins and two hosts never overlap on the data root. A failed launch leaves the state `stopped`;
   * it does not throw. Repeating the call for the state the host is already in does nothing.
   */
  want(running: boolean): Promise<void>;
  /** Ends the host for good (quit): no later exit counts as unexpected and no `want` launches anything. Waits for a call in progress first. */
  stop(): Promise<void>;
}

/** Owns the host's life for the app: its state follows the sidecar's `exited` promise, never polling. A host that is launched again gets a new sidecar, so a new launch token. */
export function createSupervisor(launch: () => Promise<Sidecar>): Supervisor {
  let state: HostState = { status: "stopped", reason: "not started" };
  let tail: Promise<void> | undefined;
  let closing = false;
  const listeners = new Set<(state: HostState) => void>();

  const set = (next: HostState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  async function run(): Promise<void> {
    set({ status: "starting" });
    let sidecar: Sidecar;
    try {
      sidecar = await launch();
    } catch (error) {
      return set({
        status: "stopped",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    void sidecar.exited.then(() => {
      if (!closing && state.status === "running" && state.sidecar === sidecar)
        set({ status: "stopped", reason: "The host exited unexpectedly." });
    });
    set({ status: "running", sidecar });
  }

  async function converge(running: boolean): Promise<void> {
    if (closing) return;
    if (running) {
      if (state.status === "paused" || state.status === "stopped") await run();
    } else if (state.status === "running") {
      const { sidecar } = state;
      set({ status: "paused" });
      await sidecar.stop();
    } else if (state.status === "stopped") {
      set({ status: "paused" });
    }
  }

  return {
    state: () => state,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    want(running) {
      const done = tail === undefined ? converge(running) : tail.then(() => converge(running));
      const mine = done
        .catch(() => {})
        .then(() => {
          if (tail === mine) tail = undefined;
        });
      tail = mine;
      return done;
    },
    async stop() {
      closing = true;
      await tail;
      if (state.status === "running") await state.sidecar.stop();
    },
  };
}
