import { z } from "zod";

import type { VerbClass } from "../verbs.ts";
import type { GmailApi } from "./client.ts";

/** What a tool may use besides the Gmail API: where the session can save files. */
export interface GmailContext {
  /** The bot's files folder; absent when the session has none. */
  filesDir?: string | undefined;
}

/** What a built-in tool makes of a call before the owner is asked: the input to approve and run, or why the call cannot be offered. */
export type ApprovalInput = { input: Record<string, unknown> } | { refused: string };

/** A tool call the bot got wrong (a missing recipient, an unknown label). `message` goes to the bot as the tool's error. */
export class ToolInputError extends Error {}

/**
 * One tool of the built-in Gmail server. Its name, description and input schema are the server's public interface; its verb class
 * decides the default policy, the annotations and whether it is locked (`../verbs.ts`). `run` returns the text the bot reads and
 * throws a `GmailError` for an API failure or a `ToolInputError` for a call it cannot carry out.
 */
export interface GmailTool {
  name: string;
  description: string;
  verb: VerbClass;
  input: z.ZodRawShape;
  run(api: GmailApi, args: Record<string, unknown>, ctx: GmailContext): Promise<string>;
  /**
   * Runs before the owner is asked to approve a call, with the call's input, and returns the input to approve and then run: a tool
   * that must pin what the owner saw adds it here, so the approval shows it and `run` can check it still holds. Throws
   * `ToolInputError` for a call that must not be offered for approval.
   */
  prepareApproval?(api: GmailApi, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function gmailTool<S extends z.ZodRawShape>(spec: {
  name: string;
  description: string;
  verb: VerbClass;
  input: S;
  run(api: GmailApi, args: z.infer<z.ZodObject<S>>, ctx: GmailContext): Promise<string>;
  prepareApproval?: (
    api: GmailApi,
    args: z.infer<z.ZodObject<S>>,
  ) => Promise<Record<string, unknown>>;
}): GmailTool {
  const { prepareApproval, ...rest } = spec;
  // Only the bot's own input becomes an input error; a Gmail answer that fails its schema stays an unreadable answer.
  const parse = (args: Record<string, unknown>) => {
    const r = z.object(spec.input).safeParse(args);
    if (r.success) return r.data;
    throw new ToolInputError(
      `Invalid input: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  };
  return {
    ...rest,
    run: (api, args, ctx) => spec.run(api, parse(args), ctx),
    ...(prepareApproval && { prepareApproval: (api, args) => prepareApproval(api, parse(args)) }),
  };
}
