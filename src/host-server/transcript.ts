import type { Database } from "bun:sqlite";
import { getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { currentSession, listBots, markSeen, getActivity, recordMessage } from "../bots/index.ts";
import { parseMentions, type Handoffs } from "../handoffs/index.ts";
import type { Bot, LastMessage, RunTrigger, ServerEvent } from "../contract/events.ts";

export type Transcript = { history: ServerEvent[]; hasSession: boolean };

const ROUTINE_TAG = /^<scheduled-routine name="([^"]*)" trigger="(schedule|manual)"/;

/** Rebuilds UI transcripts from Claude Code's own session files. */
export function createTranscripts({ cwd, db, handoffs }: { cwd: string; db: Database; handoffs: Pick<Handoffs, "receivedCards" | "sentCards"> }) {
  /** Rebuild the UI transcript of a bot's session from Claude Code's own session file. */
  async function replay(sessionId: string, ownerId: string): Promise<ServerEvent[]> {
    const out: ServerEvent[] = [];
    for (const m of await getSessionMessages(sessionId, { dir: cwd })) {
      const msg = m.message;
      const content = msg && typeof msg === "object" && "content" in msg ? msg.content : undefined;
      if (m.parent_tool_use_id) continue;
      if (m.type === "user") {
        const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.flatMap((b) => (b.type === "text" ? [b.text] : [])) : [];
        for (const text of texts) {
          const routine = text.match(ROUTINE_TAG);
          if (routine) out.push({ type: "routine", name: routine[1], trigger: routine[2] as RunTrigger });
          else if (/^<handoff(-update)? /.test(text)) out.push(...handoffs.receivedCards(text, ownerId));
          else if (!text.startsWith("<") || text.startsWith("<mention ")) {
            const { text: typed, mentions } = parseMentions(text);
            out.push(mentions.length ? { type: "user", text: typed, mentions } : { type: "user", text });
          }
        }
      } else if (m.type === "assistant" && Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "text") out.push({ type: "text_start" }, { type: "delta", text: b.text });
          if (b.type === "tool_use") out.push({ type: "tool", name: b.name, input: JSON.stringify(b.input) }, ...handoffs.sentCards(b.name, b.input as Record<string, string>, ownerId));
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
      const hasSession = !!(await getSessionInfo(current, { dir: cwd })) || (await getSessionMessages(current, { dir: cwd })).length > 0;
      const history: ServerEvent[] = [];
      for (const [i, id] of bot.sessions.entries()) {
        if (i > 0) history.push({ type: "session" });
        if (i < bot.sessions.length - 1 || hasSession) history.push(...(await replay(id, bot.id)));
      }
      return { history, hasSession };
    },

    /** Seeds sidebar activity for bots that predate it, from their newest session with chat messages; counts it as seen. */
    async backfillActivity() {
      for (const bot of listBots(cwd)) {
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
