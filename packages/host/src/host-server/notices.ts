import type { Notice } from "@claudebot/contract/events";

export interface Notices {
  /** Shows a notice to the page and queues it for the open bot to narrate. */
  notify(source: string, title: string, body?: string): void;
  /** Recent notices, replayed on connect but kept out of the chat transcript. */
  recent(): Notice[];
  /** Takes the notices not yet narrated, as the update line to show and the prompt for one turn; undefined when there are none. */
  takeUnspoken(): { update: string; prompt: string } | undefined;
}

export function createNotices(o: { broadcast(n: Notice): void; wake(): void }): Notices {
  const notices: Notice[] = [];
  let unspoken: Notice[] = [];
  return {
    notify(source, title, body = "") {
      const n: Notice = { type: "notify", source, title, body, at: Date.now() };
      notices.push(n);
      if (notices.length > 50) notices.shift();
      o.broadcast(n);
      unspoken.push(n);
      o.wake();
    },
    recent: () => notices,
    takeUnspoken() {
      if (!unspoken.length) return undefined;
      const batch = unspoken;
      unspoken = [];
      const lines = batch.map((n) => `- [${n.source}] ${n.title}${n.body ? ` — ${n.body}` : ""}`).join("\n");
      return {
        update: batch.map((n) => n.title).join(" · "),
        prompt:
          `<external-update>\nThese updates arrived from other coding agents (via herdr/omp), not from the user:\n${lines}\n` +
          `Tell the user about them in one or two natural sentences. If an agent needs input, read its pane with herdr first and say what it is asking; do not send it input unless the user tells you to.\n</external-update>`,
      };
    },
  };
}
