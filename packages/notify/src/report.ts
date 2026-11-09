import { createHash } from "node:crypto";

import { ExternalEventInput, type ReplyTarget } from "@claudebot/contract/api";

/** The words a coordinator reports with, as `notify-grok` takes them. */
export const REPORT_KINDS = ["progress", "question", "blocked", "completed", "failed"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const isReportKind = (word: string): word is ReportKind =>
  (REPORT_KINDS as readonly string[]).includes(word);

/** What each word becomes on the host. `completed` is the only rename. */
const EVENT_KIND = {
  progress: "progress",
  question: "question",
  blocked: "blocked",
  completed: "done",
  failed: "failed",
} as const satisfies Record<ReportKind, ExternalEventInput["kind"]>;

/** One report as it comes in on the command line. The three ids are identifiers, never text. */
export interface Report {
  kind: ReportKind;
  taskId: string;
  session: string;
  message: string;
  questionId?: string;
  /** Where the host relays the user's answer to (ADR-0008); it needs a `questionId` the reply can carry. */
  reply?: ReplyTarget;
}

/** Where the report comes from and how to tell it from an identical one sent on purpose. */
export interface Origin {
  /** The project slug the config was routed by, if any. It namespaces the source and the key. */
  project?: string;
  /** Mixed into the key, so that a message sent again on purpose is a new event rather than a retry. */
  salt?: string;
}

/** The host's schema limits (`ExternalEventInput`); the finished event is parsed against the schema, so a drift fails loudly. */
const LIMITS = { id: 200, label: 200, title: 200, body: 8192 } as const;

/** An identifier is one line without control characters, so it reaches the bot and the answer unchanged. */
export function checkIdentifier(name: string, value: string): string | undefined {
  if (value.trim() === "") return `${name} must not be empty`;
  if (value.length > LIMITS.id) return `${name} is longer than ${LIMITS.id} characters`;
  if (/[\p{Cc}\p{Cs}]/u.test(value)) return `${name} must be one line without control characters`;
  return undefined;
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

/** `text` cut to at most `max` UTF-16 units, ending in `marker` when anything was cut and never between a surrogate pair. */
export function truncate(text: string, max: number, marker = "…"): string {
  if (text.length <= max) return text;
  let end = max - marker.length;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end) + marker;
}

/** The body's own marker names how much was cut; its digits are reserved up front so the whole stays within the limit. */
const cutMarker = (omitted: number) => `\n… [cut: ${omitted} more characters]`;
const MARKER_RESERVE = cutMarker(999_999_999).length;

function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const kept = truncate(text, budget - MARKER_RESERVE, "");
  return kept + cutMarker(Array.from(text.slice(kept.length)).length);
}

const sha256 = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** A readable, bounded prefix of `text` in [A-Za-z0-9._-]: for people reading the database, never for identity. */
const readable = (text: string) =>
  text
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/**
 * The event a report becomes. Pure and deterministic, so a network retry sends the same thing.
 *
 * - kind: `completed` is `done`; the other four keep their word, `blocked` included.
 * - source: one per project and task. Its id is `notify:<readable prefix>:<24 hex of sha-256 over [project, task]>`:
 *   bounded, and two different pairs never collide on the readable part alone. Its label (what the user sees) is
 *   `<project> · <task>`, or the task alone without a project.
 * - key: `notify:v1:<sha-256 over [project, kind word, task, session, question id, message, salt]>`. A retry of the same
 *   report dedupes; a different message, session, question or kind is a different event. A reply target is appended to
 *   the hashed list when there is one, so the key of a report without one is the same as before reply targets existed.
 * - title: the message's first non-blank line with whitespace collapsed, cut to 200 with `…`.
 * - body: the whole message when the title is not all of it (cut to fit with a marker that says how much), then
 *   `Task`, `Session` and, when given, `Question ID`, so the bot and the user see what the report refers to.
 */
export function buildEvent(report: Report, origin: Origin = {}): ExternalEventInput {
  const { project } = origin;
  const message = report.message.replace(/\r\n?/g, "\n");
  const firstLine = message.split("\n").find((line) => line.trim() !== "") ?? "";
  const title = truncate(firstLine.replace(/\s+/g, " ").trim(), LIMITS.title);

  const facts = [
    `Task: ${report.taskId}`,
    `Session: ${report.session}`,
    ...(report.questionId === undefined ? [] : [`Question ID: ${report.questionId}`]),
  ].join("\n");
  const text = message.trim();
  const body = text === title ? facts : `${clip(text, LIMITS.body - facts.length - 2)}\n\n${facts}`;

  return ExternalEventInput.parse({
    kind: EVENT_KIND[report.kind],
    key: `notify:v1:${sha256([project ?? null, report.kind, report.taskId, report.session, report.questionId ?? null, report.message, origin.salt ?? null, ...(report.reply ? [report.reply] : [])])}`,
    source: {
      id: `notify:${readable(`${project ?? ""}/${report.taskId}`)}:${sha256([project ?? null, report.taskId]).slice(0, 24)}`,
      label: truncate(
        project === undefined ? report.taskId : `${project} · ${report.taskId}`,
        LIMITS.label,
      ),
    },
    title,
    body,
    ...(report.reply && {
      reply: report.reply,
      ...(report.questionId !== undefined && { questionId: report.questionId }),
    }),
  });
}
