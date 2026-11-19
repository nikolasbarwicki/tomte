import { SHELL_API, type PublicHostInfo } from "@tomte/contract/api";

import type { SandboxStatus } from "../../browser/index.ts";
import { VERSION } from "../../harness/index.ts";
import type { HostConfig } from "../../platform/config.ts";
import { json, type Handler } from "../http.ts";

/**
 * The host-info route, open to a device without a token: what this host is and what it can do, so the UI hides
 * actions it cannot perform. It carries no other host state; the Claude sign-in is in the `host-status` event.
 */
export function hostInfoRoute(o: { config: HostConfig; sandbox: () => SandboxStatus }): Handler {
  return async (_req, res) => {
    const body: PublicHostInfo = {
      version: VERSION,
      shellApi: SHELL_API,
      mode: o.config.mode,
      capabilities: {
        reveal: o.config.reveal,
        headedBrowser: o.config.headedBrowser,
        browserSandbox: o.sandbox().status === "available",
      },
    };
    json(res, body);
  };
}
