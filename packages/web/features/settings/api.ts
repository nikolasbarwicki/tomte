import {
  type ClaudeGateway,
  type ClaudeLoginCode,
  ClaudeLoginStart,
  Instructions,
  ModelProviders,
} from "@tomte/contract/api";
import { toast } from "sonner";

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

/** Starts a Claude sign-in on the host; resolves to the page to sign in at, or undefined after a toast when the host could not start one. */
export async function startClaudeLogin(): Promise<string | undefined> {
  const res = await post("/api/providers/claude/login", {});
  if (!res.ok) {
    toast.error(await errorOf(res));
    return undefined;
  }
  return (await readJson(res, ClaudeLoginStart)).url;
}

/** Pastes the code the sign-in page showed; resolves to the host's error message, or undefined when the CLI signed in. */
export async function submitClaudeLoginCode(code: string): Promise<string | undefined> {
  const res = await post("/api/providers/claude/login/code", { code } satisfies ClaudeLoginCode);
  return res.ok ? undefined : errorOf(res);
}

/** Ends the sign-in waiting for its code. */
export const cancelClaudeLogin = () => act("/api/providers/claude/login/cancel", {});

/** Sets the custom provider Claude runs on instead of the sign-in; resolves to the host's error message, or undefined when saved. */
export async function setClaudeGateway(gateway: ClaudeGateway): Promise<string | undefined> {
  const res = await post("/api/providers/claude/gateway", gateway);
  return res.ok ? undefined : errorOf(res);
}

/** Goes back to the Claude sign-in. */
export const removeClaudeGateway = () => act("/api/providers/claude/gateway/remove", {});
