import { Instructions, ModelProviders } from "@claudebot/contract/api";

import { act, errorOf, post, readJson } from "@/host/api.ts";

/** The instructions every bot gets; throws the host's error message when the request fails. */
export async function loadInstructions(): Promise<string> {
  const res = await post("/api/instructions", {});
  if (!res.ok) throw new Error(await errorOf(res));
  return (await readJson(res, Instructions)).text;
}

/** Replaces the instructions; resolves to whether it saved (a failure is shown as a toast). */
export const saveInstructions = (text: string) =>
  act("/api/instructions/update", { text } satisfies Instructions);

/** The model providers with their sign-in as the host sees it now; throws the host's error message when the request fails. */
export async function loadProviders(): Promise<ModelProviders["providers"]> {
  const res = await post("/api/providers", {});
  if (!res.ok) throw new Error(await errorOf(res));
  return (await readJson(res, ModelProviders)).providers;
}
