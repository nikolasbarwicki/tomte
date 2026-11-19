import { problemsOf, type HostStatus, type HostStatusEvent } from "@tomte/contract/host-status";

import { VERSION, type ClaudeAccess } from "../harness/index.ts";
import type { HostConfig } from "../platform/config.ts";
import type { Upkeep } from "../upkeep/index.ts";

/** The one value that says what this host is and what is wrong with it, composed from the facts their owners keep. */
export function createHostStatus(o: { config: HostConfig; claude: ClaudeAccess; upkeep: Upkeep }): {
  current(): HostStatus;
  /** The status as the page's stream carries it. */
  event(): HostStatusEvent;
} {
  const current = (): HostStatus => {
    const claude = o.claude.status();
    const update = o.upkeep.status();
    const offer = o.upkeep.rollbackOffer();
    return {
      version: VERSION,
      mode: o.config.mode,
      claude,
      update,
      autoUpdate: o.upkeep.autoUpdate(),
      problems: problemsOf(claude, update),
      ...(offer?.kind === "rollback" && { rollbackTo: offer.version }),
      ...(offer?.kind === "restore" && {
        restoreTo: { version: offer.version, snapshotAt: offer.snapshotAt },
      }),
    };
  };
  return { current, event: () => ({ type: "host-status", status: current() }) };
}
