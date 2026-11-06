import { toast } from "sonner";
import { hostStore } from "./store.ts";

export const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The `error` the host put in a failed response, or a generic line when it sent none. */
export async function errorOf(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => undefined);
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return `Request failed (${res.status})`;
}

/** Posts an action and shows its failure as a toast; resolves to whether it succeeded. */
export async function act(path: string, body: unknown): Promise<boolean> {
  const res = await post(path, body);
  if (res.ok) return true;
  toast.error(await errorOf(res));
  return false;
}

/** Asks the host to stream `botId`'s chat; a no-op when it already is. */
export function openBot(botId: string): void {
  if (botId !== hostStore.get().openBotId) void act("/api/open", { botId });
}

/** Tells the host the user has looked at `botId`'s finished turn. */
export const markSeen = (botId: string) => post("/api/seen", { botId });
