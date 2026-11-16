import type { Answered, CardItem, CardSource } from "../channels/index.ts";
import type { Wait, Waits } from "../waits/index.ts";
import type { Chats } from "./chats.ts";

/** How much of an approval's input a card shows. Below the channel's own card budget, which also holds the heading, the reason and the hint. */
const INPUT_BUDGET = 2400;
const REASON_BUDGET = 400;
const ANSWER_BUDGET = 200;

const TOO_LONG = "Input too long to show here. Open the web UI to approve.";
const USE_BUTTONS = "use the buttons";
const GONE = "that wait is gone";

/** `text` cut to `max` characters with an ellipsis, never inside a surrogate pair; as it is when it fits. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

const refused = (reason: string): Answered => ({ outcome: "refused", reason });

type Approval = Extract<Wait, { kind: "tool_approval" }>;

/** The exact input an approval covers, as the web UI shows it. */
const inputOf = (w: Approval) => JSON.stringify(w.payload.input, null, 2);

/** True when the card cannot show all of an approval's input: nothing that lets the tool run is then offered, because the owner would be approving what they cannot read. */
const tooLong = (w: Approval) => inputOf(w).length > INPUT_BUDGET;

/** A question linked to an external event is answered by that event's own card (through `pendingAskFor`), so it gets none. */
const hasCard = (w: Wait) => !(w.kind === "question" && w.payload.eventId !== undefined);

/** Why a wait that is not open cannot be answered. */
function closedReason(w: Wait): string {
  if (w.state === "expired") return "that wait expired";
  if (w.state === "cancelled") return "that wait was cancelled";
  return "that wait is already handled";
}

/** What a card is edited to once its wait is closed. */
function outcomeOf(w: Wait): string {
  if (w.state === "expired") return "Expired";
  if (w.state === "cancelled") return "Cancelled";
  if (w.outcome === "timeout") return "Timed out";
  const label =
    w.actions.find((a) => a.id === w.outcome)?.label ?? cut(w.outcome ?? "", ANSWER_BUDGET);
  return `Answered: ${label}`;
}

/** The card's first line, which a closed card keeps. */
function headingOf(w: Wait, botName: string | undefined): string {
  const who = botName ?? "A bot";
  switch (w.kind) {
    case "tool_approval":
      return `${who} · Allow ${w.payload.tool}?`;
    case "question":
      return `${who} asks: ${w.payload.question}`;
    case "takeover":
      return `${who} needs you: ${w.payload.reason}`;
    case "credential":
      return `${who} · Allow sign-in with "${w.payload.label}"?`;
  }
}

function bodyOf(w: Wait): string | undefined {
  switch (w.kind) {
    case "tool_approval": {
      const input = inputOf(w);
      const shown = tooLong(w) ? `${cut(input, INPUT_BUDGET)}\n\n${TOO_LONG}` : input;
      return `Reason: ${cut(w.payload.reason, REASON_BUDGET)}\n\nInput:\n${shown}\n\nReply to this message to deny with a note.`;
    }
    case "credential":
      return `${w.payload.botName} wants to sign in to ${w.payload.origin} with the stored credential "${w.payload.label}". It never sees the password.`;
    case "takeover":
    case "question":
      return undefined;
  }
}

/** The buttons of a card. Each carries an index into the wait's stored actions or options, never their text. */
function buttonsOf(w: Wait): CardItem["buttons"] {
  if (w.kind === "question")
    return (w.payload.options ?? []).map((label, i) => ({ label, arg: String(i) }));
  const all = w.actions.map((a, i) => ({ label: a.label, arg: String(i), id: a.id }));
  const offered =
    w.kind === "tool_approval" && tooLong(w) ? all.filter((b) => b.id === "deny") : all;
  return offered.map(({ label, arg }) => ({ label, arg }));
}

/**
 * Human waits as card items (`wait`): a tool approval, an `ask_user` question, a takeover and a credential approval. The items are the
 * rows of `human_waits`, so a wait that opened while the host or a channel was down is sent when it is back, and one that closes any way
 * (answered here or on the web, cancelled, expired) has its card edited. An answer goes through the same function the web UI's routes use:
 * the host, not the channel, resumes a parked run.
 */
export function createWaitCards(d: {
  waits: Pick<Waits, "list" | "get" | "answer">;
  chats: Pick<Chats, "answer">;
  botName?: (botId: string) => string | undefined;
}): CardSource {
  const cardOf = (w: Wait): CardItem => {
    const body = bodyOf(w);
    return {
      id: w.id,
      botId: w.botId,
      openedAt: w.createdAt,
      heading: headingOf(w, d.botName?.(w.botId)),
      ...(body !== undefined && { body }),
      buttons: buttonsOf(w),
      reply: w.kind === "question",
      ...(w.kind === "takeover" && { panel: "browser" }),
    };
  };

  /** Answers as the web UI's routes do: a question or an approval through the chats, which also acknowledge an event a question is about; a takeover or a sign-in approval straight to the waits. */
  function answer(w: Wait, value: string, note?: string): Answered {
    const done =
      w.kind === "question" || w.kind === "tool_approval"
        ? d.chats.answer(w.id, value, note)
        : d.waits.answer(w.id, value, note);
    if (done) return { outcome: "answered" };
    const now = d.waits.get(w.id);
    return refused(now && now.state !== "open" ? closedReason(now) : GONE);
  }

  /** The open wait a card stands for, or the refusal to give when it is gone or closed. */
  function openWait(id: string): { wait: Wait } | { refusal: Answered } {
    const w = d.waits.get(id);
    if (!w || !hasCard(w)) return { refusal: refused(GONE) };
    return w.state === "open" ? { wait: w } : { refusal: refused(closedReason(w)) };
  }

  return {
    kind: "wait",
    prefix: "w",
    open: () => d.waits.list().filter(hasCard).map(cardOf),
    view(id) {
      const w = d.waits.get(id);
      if (!w || !hasCard(w)) return undefined;
      return w.state === "open"
        ? { open: true, item: cardOf(w) }
        : { open: false, heading: headingOf(w, d.botName?.(w.botId)), outcome: outcomeOf(w) };
    },
    async press(id, arg) {
      const found = openWait(id);
      if ("refusal" in found) return found.refusal;
      const { wait: w } = found;
      const index = /^\d+$/.test(arg) ? Number(arg) : -1;
      if (w.kind === "question") {
        const option = w.payload.options?.[index];
        return option === undefined ? refused("that button is out of date") : answer(w, option);
      }
      const action = w.actions[index];
      if (!action) return refused("that button is out of date");
      // A card for an input it cut never had a button that lets the tool run, so one pressed anyway is a stale or forged callback.
      if (w.kind === "tool_approval" && tooLong(w) && action.id !== "deny")
        return refused(TOO_LONG);
      return answer(w, action.id);
    },
    async reply(id, text) {
      const found = openWait(id);
      if ("refusal" in found) return found.refusal;
      const { wait: w } = found;
      switch (w.kind) {
        // The owner's words are the note the bot receives with the denial; an approval is never changed from a channel.
        case "tool_approval":
          return answer(w, "deny", text);
        case "question":
          return answer(w, text);
        case "takeover":
        case "credential":
          return refused(USE_BUTTONS);
      }
    },
  };
}
