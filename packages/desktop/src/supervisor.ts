import type { Sidecar } from "./sidecar.ts";

/** What the tray shows. `stopped` carries the reason, which is fit to show the user. */
export type HostState =
  | { status: "starting" }
  | { status: "running"; sidecar: Sidecar }
  | { status: "stopped"; reason: string };

export interface Supervisor {
  state(): HostState;
  /** Called on every change of state, never for the state it was added in. Returns a function that removes it. */
  onChange(listener: (state: HostState) => void): () => void;
  /** Starts the host unless it is starting or running. A failed start leaves the state `stopped`; it does not throw. */
  start(): Promise<void>;
  /** Ends the host for good (quit): no later exit counts as unexpected. Waits for a start in progress first. */
  stop(): Promise<void>;
}

/** Owns the host's life for the app: its state follows the sidecar's `exited` promise, never polling. A stopped host is started again with a new sidecar, so a new launch token. */
export function createSupervisor(launch: () => Promise<Sidecar>): Supervisor {
  let state: HostState = { status: "stopped", reason: "not started" };
  let starting: Promise<void> | undefined;
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

  return {
    state: () => state,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      if (closing || state.status !== "stopped") return starting ?? Promise.resolve();
      starting = run().finally(() => (starting = undefined));
      return starting;
    },
    async stop() {
      closing = true;
      await starting;
      if (state.status === "running") await state.sidecar.stop();
    },
  };
}
