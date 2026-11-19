import { hostname } from "node:os";

import type { HostProblem, HostStatus } from "@tomte/contract/host-status";

import type { Notice } from "../channels/index.ts";

/** How the owner knows this host: the public URL's host when it is a real address, the machine's own name when the URL is the loopback one. */
export function hostNameOf(publicUrl: string): string {
  try {
    const { hostname: host } = new URL(publicUrl);
    const loopback = host === "localhost" || host === "[::1]" || host.startsWith("127.");
    if (!loopback) return host;
  } catch {
    // an unparsable public URL names nothing; the machine's name does
  }
  return hostname();
}

/**
 * Tells the owner's channels about a host problem once when it appears, not again while it lasts, and again if it clears and returns.
 * The episode lives in memory: it is derived from the status like the problem itself, so a restart that finds the problem still there
 * counts as a new episode.
 */
export function createHostAlerts(o: { hostName: string; notify(notice: Notice): void }): {
  sync(status: HostStatus): void;
} {
  let active = new Set<HostProblem["kind"]>();
  return {
    sync(status) {
      const now = new Set(status.problems.map((p) => p.kind));
      for (const problem of status.problems)
        if (!active.has(problem.kind))
          o.notify({ kind: "host_problem", hostName: o.hostName, problem });
      active = now;
    },
  };
}
