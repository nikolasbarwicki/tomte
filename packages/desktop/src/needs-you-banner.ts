import type { BotSummary } from "@claudebot/contract/events";

/** One OS banner, as the banner logic asks for it. */
export interface Note {
  title: string;
  body: string;
  onClick: () => void;
}

export interface NeedsYouBanner {
  /** The latest bots slice of the followed host. */
  update: (bots: BotSummary[]) => void;
  /** A new stream is open: its first slice is a snapshot to compare against, never a rise. Closes a banner that is up. */
  reset: () => void;
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

function describe(bot: BotSummary): Pick<Note, "title" | "body"> {
  const things = bot.needsYou === 1 ? "thing needs" : "things need";
  const body = bot.needsYouSources.join(", ");
  return {
    title: `${bot.name}: ${bot.needsYou} ${things} you`,
    body: body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - 1)}…` : body,
  };
}

/**
 * Shows one banner when the total needs-you count across bots rises while the window is hidden, naming the bot with the
 * newest open item and the sources behind its count. A later rise while the window stays hidden replaces the banner
 * instead of stacking another; showing the window closes it. Clicking it reveals the window and opens the bot that holds
 * the newest open item at that moment.
 */
export function createNeedsYouBanner(deps: {
  visible(): boolean;
  show(note: Note): { close(): void };
  reveal(): void;
  openBot(botId: string): void;
}): NeedsYouBanner {
  let latest: BotSummary[] = [];
  let total: number | undefined;
  let shown: { close(): void } | undefined;

  const close = () => {
    shown?.close();
    shown = undefined;
  };

  return {
    update(bots) {
      latest = bots;
      const before = total;
      total = bots.reduce((sum, bot) => sum + bot.needsYou, 0);
      if (before === undefined || total <= before || deps.visible()) return;
      const bot = newestBot(bots);
      if (bot === undefined) return;
      close();
      shown = deps.show({
        ...describe(bot),
        onClick() {
          deps.reveal();
          const target = newestBot(latest);
          if (target !== undefined) deps.openBot(target.id);
        },
      });
    },
    reset() {
      total = undefined;
      latest = [];
      close();
    },
    windowShown: close,
  };
}
