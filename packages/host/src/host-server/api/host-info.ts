import { API_VERSION, type PublicHostInfo } from "@tomte/contract/api";

import type { SandboxStatus } from "../../browser/index.ts";
import { VERSION, type SignInState } from "../../harness/index.ts";
import type { HostConfig } from "../../platform/config.ts";
import { json, type Handler } from "../http.ts";

/**
 * The host-info route, open to a device without a token: what this host is and what it can do, so the UI hides
 * actions it cannot perform. The Claude sign-in state is the one piece of host state it carries, in remote mode only.
 */
export function hostInfoRoute(o: {
  config: HostConfig;
  signInState: () => SignInState;
  sandbox: () => SandboxStatus;
}): Handler {
  return async (_req, res) => {
    const body: PublicHostInfo = {
      version: VERSION,
      apiVersion: API_VERSION,
      mode: o.config.mode,
      ...(o.config.mode === "remote" && { claude: o.signInState() }),
      capabilities: {
        reveal: o.config.reveal,
        headedBrowser: o.config.headedBrowser,
        browserSandbox: o.sandbox().status === "available",
      },
    };
    json(res, body);
  };
}
