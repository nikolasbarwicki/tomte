export type MentionTarget = { id: string; name: string };

/** A message cut into plain text and the `@Name` references to the given bots, in order. */
export type Segment = string | { mention: MentionTarget; text: string };

/**
 * Finds `@Name` for each target inside free text. A mention starts the text or follows whitespace, and ends where the name does
 * unless a letter or digit continues it, so `@Writer,` counts and `@Writers` does not. Longer names win, so `@Inbox handler` is
 * not read as `@Inbox`.
 */
export function splitMentions(text: string, targets: MentionTarget[]): Segment[] {
  const byLength = [...targets].sort((a, b) => b.name.length - a.name.length);
  const segments: Segment[] = [];
  let plain = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || (i > 0 && !/\s/.test(text[i - 1]!))) continue;
    const rest = text.slice(i + 1);
    const hit = byLength.find(
      (t) =>
        t.name &&
        rest.toLowerCase().startsWith(t.name.toLowerCase()) &&
        !/[\p{L}\p{N}]/u.test(rest[t.name.length] ?? ""),
    );
    if (!hit) continue;
    const end = i + 1 + hit.name.length;
    if (i > plain) segments.push(text.slice(plain, i));
    segments.push({ mention: hit, text: text.slice(i, end) });
    plain = end;
    i = end - 1;
  }
  if (plain < text.length) segments.push(text.slice(plain));
  return segments;
}

/**
 * Matches `@Name` tokens to the bots picked for them, each pick used once, in order. Names are not unique, so two picked
 * "Daily brief"s need two tokens; a token with no pick left stays plain text, and so does a pick whose token is gone.
 */
export function bindMentions(
  text: string,
  picked: MentionTarget[],
): { segments: Segment[]; mentions: MentionTarget[] } {
  const left = [...picked];
  const segments = splitMentions(text, picked).map((s) => {
    if (typeof s === "string") return s;
    const at = left.findIndex((p) => p.name === s.mention.name);
    return at < 0 ? s.text : { mention: left.splice(at, 1)[0]!, text: s.text };
  });
  return { segments, mentions: picked.filter((p) => !left.includes(p)) };
}
