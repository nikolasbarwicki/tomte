/**
 * The sidebar's bot order: `order` holds the ids the owner has placed by dragging, top first. A bot not in it (made since, or
 * never dragged) is not placed yet and stays above every placed one, in the order `bots` already has. An id in `order` that
 * names no bot is ignored, so a deleted bot needs no cleanup. The host and the page both use this, so a page can show a new
 * order before the host has confirmed it.
 */
export function arrangeBots<T extends { id: string }>(bots: T[], order: readonly string[]): T[] {
  const placed = new Map(order.map((id, rank) => [id, rank]));
  const unplaced = bots.filter((b) => !placed.has(b.id));
  const inOrder = bots
    .filter((b) => placed.has(b.id))
    .sort((a, b) => (placed.get(a.id) ?? 0) - (placed.get(b.id) ?? 0));
  return [...unplaced, ...inOrder];
}
