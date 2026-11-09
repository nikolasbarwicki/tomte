import { ReplyTarget, SlotName } from "@claudebot/contract/api";

import { ConfigError, describeSource, load, select, type Surroundings } from "./config.ts";
import { buildEvent, checkIdentifier, isReportKind, REPORT_KINDS, type Report } from "./report.ts";
import { postEvent } from "./send.ts";

/** Exit statuses, those of `notify-grok`: 2 for usage, 1 for configuration, 3 for a failed request. */
export const EXIT = { ok: 0, config: 1, usage: 2, request: 3 } as const;

const USAGE = `usage: claudebot-notify [--salt <text>] [--reply <kind>:<agent> [--reply-session <session>]] <${REPORT_KINDS.join("|")}> <task_id> <session_id> <message> [question_id]
   or: claudebot-notify --which   (print the config file in use, or "environment")`;

/** How long a request may take before it counts as failed. */
const TIMEOUT_MS = 8000;

export interface Context extends Surroundings {
  out: (line: string) => void;
  err: (line: string) => void;
  timeoutMs?: number;
}

type Parsed =
  | { command: "help" | "which" }
  | { command: "send"; report: Report; salt?: string }
  | { command: "usage"; problem: string };

/**
 * The reply target: `--reply <kind>:<agent>` or `CLAUDEBOT_REPLY`, with `--reply-session` or `CLAUDEBOT_REPLY_SESSION`.
 * The kind is everything before the first colon, so an agent name may contain colons.
 */
function replyOf(
  raw: string | undefined,
  session: string | undefined,
): ReplyTarget | undefined | string {
  if (raw === undefined) return session === undefined ? undefined : "--reply-session needs --reply";
  const colon = raw.indexOf(":");
  const parsed = ReplyTarget.safeParse({
    kind: colon < 0 ? raw : raw.slice(0, colon),
    agent: colon < 0 ? "" : raw.slice(colon + 1),
    ...(session !== undefined && { session }),
  });
  return parsed.success
    ? parsed.data
    : "--reply must be <kind>:<agent> and --reply-session a session name; names start with a letter, digit, dot, underscore or colon, never a dash, use only letters, digits and . _ : -, and are at most 128 characters";
}

/**
 * Options come first and only `--which`, `--salt <text>`, `--reply`, `--reply-session`, `--help` and `--` are options;
 * from the first other word on everything is an argument as it stands, so a message may start with a dash.
 */
function parse(argv: string[], env: Context["env"]): Parsed {
  let salt: string | undefined;
  let reply = env.CLAUDEBOT_REPLY || undefined;
  let replySession = env.CLAUDEBOT_REPLY_SESSION || undefined;
  let which = false;
  let i = 0;
  const value = () => {
    const next = argv[++i];
    return next === undefined || next === "" ? undefined : next;
  };
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--which") which = true;
    else if (arg === "--help" || arg === "-h") return { command: "help" };
    else if (arg === "--salt" || arg === "--reply" || arg === "--reply-session") {
      const given = value();
      if (given === undefined) return { command: "usage", problem: `${arg} needs a value` };
      if (arg === "--salt") salt = given;
      else if (arg === "--reply") reply = given;
      else replySession = given;
    } else if (arg === "--") {
      i++;
      break;
    } else if (arg.startsWith("-") && arg.length > 1) {
      return { command: "usage", problem: `unknown option ${arg}` };
    } else break;
  }
  if (which) return { command: "which" };

  const [kind, taskId, session, message, questionId, ...extra] = argv.slice(i);
  if (kind === undefined || taskId === undefined || session === undefined || message === undefined)
    return { command: "usage", problem: "expected a kind, task_id, session_id and message" };
  if (extra.length > 0) return { command: "usage", problem: "too many arguments" };
  if (!isReportKind(kind))
    return { command: "usage", problem: `unknown kind ${JSON.stringify(kind)}` };
  const target = replyOf(reply, replySession);
  const problem =
    checkIdentifier("task_id", taskId) ??
    checkIdentifier("session_id", session) ??
    (questionId === undefined ? undefined : checkIdentifier("question_id", questionId)) ??
    (typeof target === "string" ? target : undefined) ??
    (target !== undefined && questionId !== undefined && !SlotName.safeParse(questionId).success
      ? "with --reply, question_id must be a name the reply can carry: letters, digits and . _ : -, not starting with a dash, at most 128 characters"
      : undefined) ??
    (message.trim() === "" ? "message must not be empty" : undefined);
  if (problem !== undefined) return { command: "usage", problem };
  return {
    command: "send",
    report: {
      kind,
      taskId,
      session,
      message,
      ...(questionId !== undefined && { questionId }),
      ...(typeof target === "object" && { reply: target }),
    },
    ...(salt !== undefined && { salt }),
  };
}

/** Runs the sender on `argv` (without the program name) and returns the exit status. Secrets never reach `out` or `err`. */
export async function run(argv: string[], ctx: Context): Promise<number> {
  const say = (line: string) => ctx.err(`claudebot-notify: ${line}`);
  const parsed = parse(argv, ctx.env);
  if (parsed.command === "help") {
    ctx.out(USAGE);
    return EXIT.ok;
  }
  if (parsed.command === "usage") {
    say(parsed.problem);
    ctx.err(USAGE);
    return EXIT.usage;
  }

  try {
    const { source, project } = await select(ctx);
    if (parsed.command !== "send") {
      ctx.out(describeSource(source));
      return EXIT.ok;
    }
    const { config, warning } = await load(source, ctx.env);
    if (warning !== undefined) say(`warning: ${warning}`);
    const event = buildEvent(parsed.report, {
      ...(project !== undefined && { project }),
      ...(parsed.salt !== undefined && { salt: parsed.salt }),
    });
    const outcome = await postEvent(config, event, ctx.timeoutMs ?? TIMEOUT_MS);
    if (!outcome.ok) {
      say(outcome.message);
      return EXIT.request;
    }
    ctx.out(outcome.duplicate ? "ok (duplicate)" : "ok");
    return EXIT.ok;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    say(e.message);
    return EXIT.config;
  }
}
