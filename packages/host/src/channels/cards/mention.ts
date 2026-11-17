const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a message that starts with `@` addresses: the bot, and the message with the name (and a `:` or `,` right after it) taken off. */
export type Mention = { bot: { id: string; name: string }; rest: string };

/**
 * `undefined` when the text does not start with `@`; `null` when it does but no bot's full name follows; otherwise the bot and the rest.
 * A name matches without regard to case or to how many spaces lie between its words, and needs a space, `:`, `,` or the end of the text
 * after it, so `@Job` never reaches a bot named "Jobs". With several matches the longest name wins, so `@Job scout hi` reaches "Job scout"
 * even when a bot named "Job" exists; of two bots with the same name, the first listed wins.
 */
export function leadingMention(
  text: string,
  bots: { id: string; name: string }[],
): Mention | null | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("@")) return undefined;
  const after = trimmed.slice(1);
  let best: { bot: { id: string; name: string }; length: number; matched: number } | undefined;
  for (const bot of bots) {
    const words = bot.name.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const matched = new RegExp(`^${words.map(escapeRegExp).join("\\s+")}(?=[\\s:,]|$)`, "iu").exec(
      after,
    );
    const length = words.join(" ").length;
    if (matched && (!best || length > best.length))
      best = { bot, length, matched: matched[0].length };
  }
  if (!best) return null;
  return { bot: best.bot, rest: after.slice(best.matched).replace(/^[:,]?\s*/, "") };
}
