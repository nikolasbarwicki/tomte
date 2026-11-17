import { PairingResponse } from "@tomte/contract/api";

import { errorOf, post, readJson } from "@/host/api.ts";
import { sessionStore } from "@/host/session.ts";

/**
 * Exchanges a pairing code for this browser's session. The host sets the HttpOnly cookie, so the token in the
 * body is validated and dropped. Resolves to the host's error, or `undefined` once the page is paired.
 */
export async function pair(code: string, name: string): Promise<string | undefined> {
  const res = await post("/api/pair", { code, name });
  if (!res.ok) return errorOf(res);
  await readJson(res, PairingResponse);
  sessionStore.set("paired");
  return undefined;
}
