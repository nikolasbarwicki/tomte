import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useMediaQuery } from "@/hooks/use-media-query";
import { DEFAULT_PANEL_SECTION, type PanelSection } from "@/lib/bot-panel.ts";

const PANEL_KEY = "tomte:panel";
const botRoute = getRouteApi("/bots/$botId");

/** What the rail, the panel and the chat's own buttons share: whether the panel is open, on which section, and how to change both. */
export interface PanelControls {
  /** Side by side with the chat (wide window), or a sheet over it. */
  wide: boolean;
  open: boolean;
  /** The section the panel shows, or would show when opened. */
  section: PanelSection;
  /** Opens the panel on a section; for the section already on screen it closes the panel instead. */
  pick: (section: PanelSection) => void;
  /** Opens the panel on a section, whatever is on screen: for something that has to be seen. */
  show: (section: PanelSection) => void;
  close: () => void;
  /** Opens or closes the panel on its current section. */
  toggle: () => void;
}

/**
 * The panel's state. The section is the `panel` search param, so a link can name one; open or closed is the user's own choice,
 * remembered across bots and reloads for a wide window and per page for the sheet of a narrow one. A link that names a section
 * opens the panel on it.
 */
export function usePanel(): PanelControls {
  const wide = useMediaQuery("(min-width: 1024px)");
  const [pinned, setPinned] = useState(() => localStorage.getItem(PANEL_KEY) !== "closed");
  const [sheetOpen, setSheetOpen] = useState(false);
  const navigate = botRoute.useNavigate();
  const linked = botRoute.useSearch({ select: (s) => s.panel });
  const section = linked ?? DEFAULT_PANEL_SECTION;
  const open = wide ? pinned : sheetOpen;
  const setOpen = (next: boolean) => (wide ? setPinned(next) : setSheetOpen(next));
  useEffect(() => localStorage.setItem(PANEL_KEY, pinned ? "open" : "closed"), [pinned]);

  // A link that names a section opens the panel on it, once per link.
  const [openedFor, setOpenedFor] = useState<PanelSection>();
  if (linked !== openedFor) {
    setOpenedFor(linked);
    if (linked) setOpen(true);
  }

  const show = (next: PanelSection) => {
    void navigate({ search: (prev) => ({ ...prev, panel: next }), replace: true });
    setOpen(true);
  };
  return {
    wide,
    open,
    section,
    pick: (next) => (open && next === section ? setOpen(false) : show(next)),
    show,
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
  };
}
