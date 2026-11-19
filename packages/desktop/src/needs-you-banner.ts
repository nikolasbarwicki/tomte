import type { BotSummary } from "@tomte/contract/events";
import type { HostStatus } from "@tomte/contract/host-status";

import { problemText } from "./host-lines.ts";

/** One OS banner, as the banner logic asks for it. */
export interface Note {
  title: string;
  body: string;
  onClick: () => void;
}

/** The host a slice or a status belongs to, as the banner names it. */
interface HostRef {
  id: string;
  name: string;
}

export interface NeedsYouBanner {
  /** The latest bots slice of a host. */
  bots: (host: HostRef, bots: BotSummary[]) => void;
  /** The latest status of a host. */
  status: (host: HostRef, status: HostStatus) => void;
  /** A host's stream is open again, or the host is no longer followed: its next slice and status are a snapshot to compare against, never a rise. Closes a banner of that host that is up. */
  reset: (hostId: string) => void;
  /** The window was shown: the banner has done its job. */
  windowShown: () => void;
}

const BODY_LIMIT = 200;

/** The bot holding the newest open item: the latest arrival, the first listed on a tie. */
function newestBot(bots: BotSummary[]): BotSummary | undefined {
  let newest: BotSummary | undefined;
  for (const bot of bots)
    if (bot.needsYou > 0 && (newest === undefined || bot.needsYouAt > newest.needsYouAt))
      newest = bot;
  return newest;
}

function describe(host: HostRef, bot: BotSummary): Pick<Note, "title" | "body"> {
  const things = bot.needsYou === 1 ? "thing needs" : "things need";
  const body = bot.needsYouSources.join(", ");
  return {
    title: `${bot.name} (${host.name}): ${bot.needsYou} ${things} you`,
    body: body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - 1)}…` : body,
  };
}

/** What the app knows of one host; a count is `undefined` until the host's first snapshot has set the baseline. */
interface Seen {
  bots: BotSummary[];
  items: number | undefined;
  problems: number | undefined;
}

/**
 * Shows one banner when something that needs the user rises on any followed host while the window is hidden: the open
 * items across a host's bots, or a problem of the host itself. The title names the host. An item names the bot with the
 * newest open item and the sources behind its count; a problem names the problem. A later rise while the window stays
 * hidden replaces the banner instead of stacking another; showing the window closes it. Clicking it reveals the window,
 * switches to that host and opens the bot that holds the newest open item at that moment (the host alone, for a problem).
 */
export function createNeedsYouBanner(deps: {
  visible(): boolean;
  show(note: Note): { close(): void };
  reveal(): void;
  open(hostId: string, botId: string | undefined): void;
}): NeedsYouBanner {
  const hosts = new Map<string, Seen>();
  let shown: { hostId: string; close(): void } | undefined;

  const close = () => {
    shown?.close();
    shown = undefined;
  };
  const seen = (host: HostRef): Seen => {
    let entry = hosts.get(host.id);
    if (entry === undefined)
      hosts.set(host.id, (entry = { bots: [], items: undefined, problems: undefined }));
    return entry;
  };
  const raise = (
    host: HostRef,
    note: Pick<Note, "title" | "body">,
    botOf?: () => string | undefined,
  ) => {
    if (deps.visible()) return;
    close();
    shown = {
      hostId: host.id,
      ...deps.show({
        ...note,
        onClick() {
          deps.reveal();
          deps.open(host.id, botOf?.());
        },
      }),
    };
  };

  return {
    bots(host, bots) {
      const entry = seen(host);
      const before = entry.items;
      entry.bots = bots;
      entry.items = bots.reduce((sum, bot) => sum + bot.needsYou, 0);
      if (before === undefined || entry.items <= before) return;
      const bot = newestBot(bots);
      if (bot !== undefined) raise(host, describe(host, bot), () => newestBot(entry.bots)?.id);
    },
    status(host, status) {
      const entry = seen(host);
      const before = entry.problems;
      entry.problems = status.problems.length;
      const problem = status.problems[0];
      if (before === undefined || entry.problems <= before || problem === undefined) return;
      raise(host, {
        title: `${host.name}: ${problemText(problem)}`,
        body: "Open Tomte to fix it.",
      });
    },
    reset(hostId) {
      hosts.delete(hostId);
      if (shown?.hostId === hostId) close();
    },
    windowShown: close,
  };
}
