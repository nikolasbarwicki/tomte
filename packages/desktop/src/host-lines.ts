import { needsYou, updateFailedText } from "@tomte/contract/host-status";
import type { HostProblem } from "@tomte/contract/host-status";

import type { ProfileView } from "./connections.ts";
import type { HostView } from "./follow-hosts.ts";
import { LOCAL_ID } from "./profile-store.ts";
import type { HostState } from "./supervisor.ts";

type HostLineState =
  | "starting"
  | "running"
  | "paused"
  | "stopped"
  | "connecting"
  | "connected"
  | "unreachable";

/** What the tray says about one host: the facts, not the wording; `hostLineText` words them. */
export interface HostLine {
  id: string;
  name: string;
  state: HostLineState;
  /** The contract's `needsYou`: open items across the host's bots plus its problems. */
  needsYou: number;
  /** The host's first problem, if it has one. */
  problem?: HostProblem;
}

/** A problem as short text, in the tray and in a banner's title. */
export function problemText(problem: HostProblem): string {
  switch (problem.kind) {
    case "claude-signed-out":
      return problem.reason === "token-rejected" ? "Claude token rejected" : "Claude signed out";
    case "update-failed":
      return updateFailedText(problem);
  }
}

/** "This computer: running · 1 needs you", "my-vps: connected · Claude signed out". */
export function hostLineText(line: HostLine): string {
  const parts: string[] = [line.state];
  if (line.needsYou > 0)
    parts.push(`${line.needsYou} ${line.needsYou === 1 ? "needs" : "need"} you`);
  if (line.problem !== undefined) parts.push(problemText(line.problem));
  return `${line.name}: ${parts.join(" · ")}`;
}

/** One line per profile, this computer first: its state is the supervisor's, a server's is what its event stream says. A host that is not up (a paused one included) shows no count and no problem, since what it last said is out of date. */
export function hostLines(
  profiles: readonly ProfileView[],
  local: HostState,
  view: (id: string) => HostView | undefined,
): HostLine[] {
  return profiles.map(({ id, name }): HostLine => {
    const followed = view(id);
    const state: HostLineState =
      id === LOCAL_ID
        ? local.status
        : followed === undefined || followed.connection === "connecting"
          ? "connecting"
          : followed.connection === "open"
            ? "connected"
            : "unreachable";
    if (
      followed === undefined ||
      followed.connection !== "open" ||
      (id === LOCAL_ID && local.status !== "running")
    )
      return { id, name, state, needsYou: 0 };
    const problem = followed.status?.problems[0];
    return {
      id,
      name,
      state,
      needsYou: needsYou(followed.bots ?? [], followed.status),
      ...(problem && { problem }),
    };
  });
}
