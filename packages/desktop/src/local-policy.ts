import { LOCAL_ID } from "./profile-store.ts";
import type { LocalHostSetting, SettingsStore } from "./settings.ts";
import type { Supervisor } from "./supervisor.ts";

/** `off` in this variable means the app never opens the one-time question (it counts as "ask me later"). The smoke kit sets it for every launch it makes, so no smoke ever opens an OS dialog; a smoke of the question itself leaves it unset and replaces the question in the main process. */
export const LOCAL_HOST_QUESTION_ENV = "TOMTE_DESKTOP_LOCAL_HOST_QUESTION";

/** Whether this computer's host should run while `shown` is the connection the window shows. No answer yet runs it: nothing pauses before the user has chosen. */
export function localWanted(setting: LocalHostSetting | undefined, shown: string): boolean {
  return setting !== "while-shown" || shown === LOCAL_ID;
}

/** `later` leaves the question open: it is asked again the next time a server is shown. */
export type LocalHostAnswer = LocalHostSetting | "later";

export interface LocalHostPolicy {
  /** The connection the window shows is `shown` (or still is): asks the one-time question when a server has just been shown and nothing has been answered, then makes the host run or pause. */
  reconcile(shown: { id: string; name: string }): Promise<void>;
  /** The setting changed (the tray) or the question can be asked now (the window appeared): applies it to the connection shown last. */
  refresh(): Promise<void>;
}

/** Joins the setting, the connection the window shows and the supervisor: the host's wish is `localWanted` of the two, given to `supervisor.want` only when it differs from the last one given, so a host that crashed is not started again by an unrelated change. */
export function createLocalHostPolicy(deps: {
  settings: SettingsStore;
  supervisor: Pick<Supervisor, "want">;
  /** Asks "Keep bots on this Mac running while you use <serverName>?". Called at most once at a time. */
  ask(serverName: string): Promise<LocalHostAnswer>;
  /** Whether the question may appear now; a hidden window does not get a dialog. */
  canAsk(): boolean;
}): LocalHostPolicy {
  let shown: { id: string; name: string } | undefined;
  let applied: boolean | undefined;
  let asking = false;
  /** The server the question was last opened for; forgotten when This computer is shown, so the next server asks again. */
  let askedFor: string | undefined;

  async function apply(): Promise<void> {
    if (shown === undefined) return;
    const wanted = localWanted(deps.settings.get().localHost, shown.id);
    if (wanted === applied) return;
    applied = wanted;
    await deps.supervisor.want(wanted);
  }

  async function ask(server: { id: string; name: string }): Promise<void> {
    asking = true;
    askedFor = server.id;
    try {
      const answer = await deps.ask(server.name);
      if (answer !== "later") deps.settings.update({ localHost: answer });
    } finally {
      asking = false;
    }
  }

  async function reconcile(): Promise<void> {
    if (shown === undefined) return;
    if (shown.id === LOCAL_ID) askedFor = undefined;
    else if (
      deps.settings.get().localHost === undefined &&
      !asking &&
      askedFor !== shown.id &&
      deps.canAsk()
    ) {
      // The host runs, as it does before any answer, while the question is open.
      const running = apply();
      await ask(shown);
      await running;
    }
    await apply();
  }

  return {
    reconcile(next) {
      shown = next;
      return reconcile();
    },
    refresh: reconcile,
  };
}
