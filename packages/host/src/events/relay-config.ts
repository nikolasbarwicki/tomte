import { statSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { SlotName, type ReplyTarget } from "@claudebot/contract/api";
import { z } from "zod";

/** What an adapter's `args` may name as a whole element. Everything else in `args` is literal text the operator wrote. */
const PLACEHOLDERS = ["agent", "session", "message", "answer", "questionId"] as const;
type Placeholder = (typeof PLACEHOLDERS)[number];

const isPlaceholder = (name: string): name is Placeholder =>
  (PLACEHOLDERS as readonly string[]).includes(name);

const ANY_PLACEHOLDER = /\{([A-Za-z]+)\}/;
const WHOLE_PLACEHOLDER = /^\{([A-Za-z]+)\}$/;

const Adapter = z
  .object({
    /** The program to run: an absolute path, so what runs does not depend on `PATH`. */
    command: z.string().refine(isAbsolute, "must be an absolute path"),
    /** Its arguments: literal text, or a placeholder as a whole element. */
    args: z
      .array(z.string())
      .max(64)
      .superRefine((args, ctx) => {
        for (const [i, arg] of args.entries()) {
          const found = ANY_PLACEHOLDER.exec(arg);
          if (found === null) continue;
          const whole = WHOLE_PLACEHOLDER.exec(arg)?.[1];
          if (whole === undefined || !isPlaceholder(whole))
            ctx.addIssue({
              code: "custom",
              path: [i],
              message: `a placeholder must be a whole argument and one of ${PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`,
            });
        }
      }),
    /** The session when an event names none. */
    defaultSession: SlotName.default("default"),
    /** When given, the only agents an event may name; remote mode requires it. */
    allowAgents: z.array(SlotName).max(256).optional(),
    /** When given, the only sessions an event may name (the default session is always allowed). */
    allowSessions: z.array(SlotName).max(256).optional(),
    timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    /** Variables the adapter's process gets besides the few every adapter gets; values are literal. */
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)).optional(),
  })
  .strict();
export type RelayAdapter = z.infer<typeof Adapter>;

const RelayConfig = z
  .object({
    adapters: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), Adapter),
  })
  .strict();
type RelayConfig = z.infer<typeof RelayConfig>;

export type RelayConfigResult = { ok: true; config: RelayConfig } | { ok: false; reason: string };

/**
 * Reads the operator's relay configuration (ADR-0008). Nothing is cached, so a corrected file works at the next attempt.
 * `reason` is a line for the user, free of the file's path and contents. A file others can write is refused: whoever
 * could write it could make the host run a program. Remote mode requires `allowAgents` on every adapter.
 */
export function readRelayConfig(path: string, remote: boolean): RelayConfigResult {
  let text: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { ok: false, reason: "the relay configuration is not a file" };
    if (process.platform !== "win32" && (stat.mode & 0o022) !== 0)
      return {
        ok: false,
        reason: "the relay configuration is writable by group or others; run chmod go-w on it",
      };
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: false, reason: "no relay is configured on this host" };
    return { ok: false, reason: "the relay configuration cannot be read" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the relay configuration is not valid JSON" };
  }
  const parsed = RelayConfig.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `the relay configuration is invalid at ${issue?.path.join(".") || "its top level"}: ${issue?.message}`,
    };
  }
  if (remote)
    for (const [name, a] of Object.entries(parsed.data.adapters))
      if (a.allowAgents === undefined)
        return {
          ok: false,
          reason: `the relay adapter "${name}" needs allowAgents in remote mode`,
        };
  return { ok: true, config: parsed.data };
}

/** The slots an event fills, already validated by the events route. */
export interface RelayJob {
  reply: ReplyTarget;
  questionId: string | undefined;
  answer: string;
}

/** `undefined` when the adapter lets this target through, else the reason it does not. */
export function refuseTarget(adapter: RelayAdapter, reply: ReplyTarget): string | undefined {
  if (adapter.allowAgents && !adapter.allowAgents.includes(reply.agent))
    return `agent "${reply.agent}" is not allowed for relay "${reply.kind}"`;
  const session = reply.session ?? adapter.defaultSession;
  if (
    reply.session !== undefined &&
    reply.session !== adapter.defaultSession &&
    adapter.allowSessions &&
    !adapter.allowSessions.includes(reply.session)
  )
    return `session "${session}" is not allowed for relay "${reply.kind}"`;
  return undefined;
}

/**
 * The adapter's argv: its literal elements, and for each placeholder one element holding the value as it is, newlines and
 * quotes included. `{message}` is the answer followed by ` (<question id>)`, or the answer alone without a question id.
 * A value is never split or joined to another, and nothing here is interpreted by a shell.
 */
export function buildArgv(adapter: RelayAdapter, job: RelayJob): string[] {
  const values: Record<Placeholder, string> = {
    agent: job.reply.agent,
    session: job.reply.session ?? adapter.defaultSession,
    message: job.questionId === undefined ? job.answer : `${job.answer} (${job.questionId})`,
    answer: job.answer,
    questionId: job.questionId ?? "",
  };
  return adapter.args.map((arg) => {
    const name = WHOLE_PLACEHOLDER.exec(arg)?.[1];
    return name !== undefined && isPlaceholder(name) ? values[name] : arg;
  });
}
