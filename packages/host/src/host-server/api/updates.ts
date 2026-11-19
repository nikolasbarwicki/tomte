import { UpdateAction } from "@tomte/contract/update";

import { UpdateRefused } from "../../upkeep/index.ts";
import { json } from "../http.ts";
import type { ApiContext, ApiRoutes } from "./context.ts";

/** The host's own update: one route that takes an `UpdateAction` and answers the `UpdateStatus` it leaves; an action that does not apply to the host as it is answers 409 with why. */
export function updateRoutes({ upkeep }: ApiContext): ApiRoutes {
  return {
    "/api/updates/run": async ({ res, parse }) => {
      const action = parse(UpdateAction);
      try {
        return json(res, await upkeep.run(action));
      } catch (e) {
        if (e instanceof UpdateRefused) return json(res, { error: e.message }, 409);
        throw e;
      }
    },
  };
}
