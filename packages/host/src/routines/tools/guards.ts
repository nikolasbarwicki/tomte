import type { z } from "zod";

export const UNATTENDED_REFUSAL =
  "scheduled runs cannot create or change routines; ask the user in chat";

/** The first issue of a route schema's failure as `<path>: <message>` (just the message at the root), so the bot can fix it and retry. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid input";
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}
