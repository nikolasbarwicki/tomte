import { arrangeBots } from "@tomte/contract/bot-order";
import type { BotSummary } from "@tomte/contract/events";
import { useState, type DragEvent, type HTMLAttributes } from "react";

import { reorderBots } from "@/host/api.ts";

type Edge = "before" | "after";

/** `ids` with `moved` taken out and put on `edge` of `target`. */
function moveBot(ids: string[], moved: string, target: string, edge: Edge): string[] {
  const rest = ids.filter((id) => id !== moved);
  const at = rest.indexOf(target) + (edge === "after" ? 1 : 0);
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export type RowProps = HTMLAttributes<HTMLElement> & {
  "data-dragging"?: true | undefined;
  "data-drop"?: Edge | undefined;
};

/**
 * Drag-and-drop order for the sidebar's bots. `shown` is the host's order, or the one just dropped until the host's order
 * changes (it confirmed the drop, or something else moved). `rowProps(id)` goes on each row: it makes the row draggable and
 * marks the edge a drop would land on.
 */
export function useBotOrder(bots: BotSummary[]) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; edge: Edge } | null>(null);
  const [dropped, setDropped] = useState<{ order: string[]; hostOrder: string } | null>(null);

  const hostOrder = bots.map((b) => b.id).join();
  const shown = dropped?.hostOrder === hostOrder ? arrangeBots(bots, dropped.order) : bots;
  const shownIds = shown.map((b) => b.id);

  const edgeAt = (e: DragEvent<HTMLElement>): Edge => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2 ? "before" : "after";
  };
  const end = () => {
    setDragging(null);
    setOver(null);
  };

  const rowProps = (id: string): RowProps => ({
    draggable: true,
    "data-dragging": dragging === id ? true : undefined,
    "data-drop": over?.id === id ? over.edge : undefined,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
      setDragging(id);
    },
    onDragOver: (e) => {
      if (!dragging || dragging === id) return;
      e.preventDefault();
      const edge = edgeAt(e);
      if (over?.id !== id || over.edge !== edge) setOver({ id, edge });
    },
    onDrop: (e) => {
      if (!dragging || dragging === id) return;
      e.preventDefault();
      const next = moveBot(shownIds, dragging, id, edgeAt(e));
      end();
      if (sameIds(next, shownIds)) return;
      setDropped({ order: next, hostOrder });
      void reorderBots(next).then((ok) => {
        if (!ok) setDropped((d) => (d?.order === next ? null : d));
      });
    },
    onDragEnd: end,
  });

  return { shown, rowProps };
}
