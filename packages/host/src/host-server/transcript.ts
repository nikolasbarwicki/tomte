import type { Database } from "bun:sqlite";

import {
  getSessionInfo,
  getSessionMessages,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  RunTrigger,
  type Bot,
  type LastMessage,
  type ServerEvent,
} from "@claudebot/contract/events";
import { z } from "zod";

import { currentSession, listBots, markSeen, getActivity, recordMessage } from "../bots/index.ts";
import type { Events } from "../events/index.ts";
import { parseMentions, type Handoffs } from "../handoffs/index.ts";
import { withoutWorkState } from "../loop/index.ts";

export type Transcript = { history: ServerEvent[]; hasSession: boolean };

const ROUTINE_TAG = /^<scheduled-routine name="([^"]*)" trigger="(schedule|manual)"/;

/** A tool call's input as the session file holds it; handoff cards read only its text fields. */
const ToolInput = z
  .record(z.string(), z.unknown())
  .catch({})
  .transform((input) =>
    Object.fromEntries(
      Object.entries(input).filter((e): e is [string, string] => typeof e[1] === "string"),
    ),
  );

/** Whether the app wrote a user message, not the user: a message that did not come from a person carries another origin than `human` in the session file (`getSessionMessages` already leaves out the ones Claude Code marks as meta). The field is not in the SDK's type. */
function writtenByApp(m: SessionMessage): boolean {
  const { origin } = m as SessionMessage & { origin?: { kind?: string } };
  return origin !== undefined && origin.kind !== "human";
}

/** Rebuilds UI transcripts from Claude Code's own session files. */
export function createTranscripts({
  cwd,
  dataRoot,
  db,
  handoffs,
  events,
}: {
  cwd: string;
  dataRoot: string;
  db: Database;
  handoffs: Pick<Handoffs, "receivedCards" | "sentCards">;
  events: Pick<Events, "split">;
}) {
  /** Rebuild the UI transcript of a bot's session from Claude Code's own session file. */
  async function replay(sessionId: string, ownerId: string): Promise<ServerEvent[]> {
    const out: ServerEvent[] = [];
    for (const m of await getSessionMessages(sessionId, { dir: cwd })) {
      const msg = m.message;
      const content = msg && typeof msg === "object" && "content" in msg ? msg.content : undefined;
      if (m.parent_tool_use_id) continue;
      if (m.type === "user") {
        const texts =
          typeof content === "string"
            ? [content]
            : Array.isArray(content)
              ? content.flatMap((b) => (b.type === "text" ? [b.text] : []))
              : [];
        // A double-loop front's messages end with the work state the app appended, which the user never saw. What the app itself wrote there (a queued task's dispatch, a restart notice) is not the user's text either; the cards its events and handoffs become still show.
        const stripped = texts.map(withoutWorkState);
        const appText = writtenByApp(m) && stripped.some((t, i) => t !== texts[i]);
        for (const piece of stripped.flatMap((t) => events.split(ownerId, t))) {
          if (typeof piece !== "string") out.push(piece);
          else {
            const routine = piece.match(ROUTINE_TAG);
            if (routine)
              out.push({
                type: "routine",
                name: routine[1] ?? "",
                trigger: RunTrigger.parse(routine[2]),
              });
            else if (/^<handoff(-update)? /.test(piece))
              out.push(...handoffs.receivedCards(piece, ownerId));
            else if (appText) continue;
            else if (!piece.startsWith("<") || piece.startsWith("<mention ")) {
              const { text: typed, mentions } = parseMentions(piece);
              out.push(
                mentions.length
                  ? { type: "user", text: typed, mentions }
                  : { type: "user", text: piece },
              );
            }
          }
        }
      } else if (m.type === "assistant" && Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "text") out.push({ type: "text_start" }, { type: "delta", text: b.text });
          if (b.type === "tool_use")
            out.push(
              { type: "tool", name: b.name, input: JSON.stringify(b.input) },
              ...handoffs.sentCards(b.name, ToolInput.parse(b.input), ownerId),
            );
        }
      }
    }
    if (out.length) out.push({ type: "done" });
    return out;
  }

  return {
    /** Reads a bot's whole transcript, across its sessions, from Claude Code's session files. */
    async transcript(bot: Bot): Promise<Transcript> {
      // getSessionInfo has no summary for a session whose first message is a host tag (<handoff>, <scheduled-routine>), so fall back to its messages.
      const current = currentSession(bot);
      const hasSession =
        current !== undefined &&
        (!!(await getSessionInfo(current, { dir: cwd })) ||
          (await getSessionMessages(current, { dir: cwd })).length > 0);
      const history: ServerEvent[] = [];
      for (const [i, id] of bot.sessions.entries()) {
        if (i > 0) history.push({ type: "session" });
        if (i < bot.sessions.length - 1 || hasSession) history.push(...(await replay(id, bot.id)));
      }
      return { history, hasSession };
    },

    /** Seeds sidebar activity for bots that predate it, from their newest session with chat messages; counts it as seen. */
    async backfillActivity() {
      for (const bot of listBots(dataRoot)) {
        if (getActivity(db, bot.id)) continue;
        for (const id of [...bot.sessions].reverse()) {
          const info = await getSessionInfo(id, { dir: cwd });
          if (!info) continue;
          let last: LastMessage | undefined;
          for (const e of await replay(id, bot.id)) {
            if (e.type === "user") last = { from: "user", text: e.text, at: info.lastModified };
            if (e.type === "delta") last = { from: "bot", text: e.text, at: info.lastModified };
          }
          if (!last) continue;
          recordMessage(db, bot.id, last);
          markSeen(db, bot.id, last.at);
          break;
        }
      }
    },
  };
}
