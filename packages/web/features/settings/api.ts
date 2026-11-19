import {
  type ClaudeGateway,
  type ClaudeLoginCode,
  type ClaudeLongLivedToken,
  ClaudeLoginStart,
  ClaudeTokenSaved,
  ClaudeUsage,
  Instructions,
  ModelProviders,
} from "@tomte/contract/api";
import type { UpdateAction } from "@tomte/contract/update";
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

/** The Claude subscription's session and weekly usage as the CLI reports it now; throws the host's error message when it cannot tell. */
export async function loadClaudeUsage(): Promise<ClaudeUsage> {
  const res = await post("/api/providers/claude/usage", {});
  if (!res.ok) throw new Error(await errorOf(res));
  return readJson(res, ClaudeUsage);
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

/** Asks the host to do something about its own update; resolves to whether it did (the host's reason is shown as a toast). The host's status event brings the new state. */
export const runUpdate = (action: UpdateAction) => act("/api/updates/run", action);

/** Stores a long-lived token (from `claude setup-token`) for Claude to use instead of the sign-in; resolves to why Claude is not signed in with it (the host's error, or the CLI not accepting it), or undefined when it is. */
export async function setClaudeLongLivedToken(token: string): Promise<string | undefined> {
  const res = await post("/api/providers/claude/token", { token } satisfies ClaudeLongLivedToken);
  if (!res.ok) return errorOf(res);
  const { status } = await readJson(res, ClaudeTokenSaved);
  return status === "connected"
    ? undefined
    : "Claude did not accept that token. Remove it to use another way of signing in.";
}

/** Goes back to the Claude sign-in. */
export const removeClaudeLongLivedToken = () => act("/api/providers/claude/token/remove", {});
