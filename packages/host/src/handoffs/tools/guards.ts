export const MAX_TITLE_LENGTH = 80;
export const MAX_CHAIN_DEPTH = 3;
export const MAX_OPEN_PER_REQUESTER = 5;

type Edge = { requesterId: string; assigneeId: string };

/** Longest run of open handoffs starting at `from` and following `next`; `seen` stops any unexpected loop. */
function longest(
  from: string,
  next: (id: string) => string[],
  seen: Set<string> = new Set(),
): number {
  if (seen.has(from)) return 0;
  const path = new Set(seen).add(from);
  return Math.max(0, ...next(from).map((n) => 1 + longest(n, next, path)));
}

/** Plain reason a new handoff must be refused, or undefined if it may be created. `edges` are the open handoffs. */
export function handOffRefusal(input: {
  from: string;
  to: string;
  title: string;
  brief: string;
  edges: Edge[];
}): string | undefined {
  const { from, to, title, brief, edges } = input;
  if (from === to) return "you cannot hand off to yourself";
  if (brief.trim() === "") return "the brief is empty; write a self-contained brief";
  if (title.length > MAX_TITLE_LENGTH)
    return `the title is ${title.length} characters; keep it to ${MAX_TITLE_LENGTH} or fewer`;

  const out = (id: string) => edges.filter((e) => e.requesterId === id).map((e) => e.assigneeId);
  const into = (id: string) => edges.filter((e) => e.assigneeId === id).map((e) => e.requesterId);

  const reaches = (start: string, seen = new Set<string>()): boolean => {
    if (start === from) return true;
    if (seen.has(start)) return false;
    seen.add(start);
    return out(start).some((n) => reaches(n, seen));
  };
  if (reaches(to))
    return "this would create a loop of handoffs: that bot is already waiting, directly or through others, on you";

  const chain = longest(from, into) + 1 + longest(to, out);
  if (chain > MAX_CHAIN_DEPTH)
    return `this would make a chain of ${chain} open handoffs; the maximum is ${MAX_CHAIN_DEPTH}`;

  if (out(from).length >= MAX_OPEN_PER_REQUESTER)
    return `you already have ${MAX_OPEN_PER_REQUESTER} open handoffs; wait for one to finish`;
  return undefined;
}
