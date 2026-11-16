import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { EngineError, type PageData } from "../engine-cli.ts";
import { detectBotWall, detectLoginWall, VENDOR_NAMES, type BotWallVendor } from "../page-walls.ts";
import { shapePage } from "../shape.ts";
import type { BrowserToolContext } from "./context.ts";
import { guarded, textResult, ToolError } from "./result.ts";

/** What a tool produced: the text for the bot and what the page looked like afterwards, for the loop guard. */
export interface Outcome {
  text: string;
  page: string;
}

const NO_PAGE = "(empty page)";

/** How many times a page behind a bot wall is looked at again, `wallPauseMs` apart; a wall that is still there after that is handed to the bot. */
const WALL_RECHECKS = 3;

const botWallNote = (vendor: BotWallVendor) =>
  `Note from the host: this page is behind ${VENDOR_NAMES[vendor]} bot protection and did not clear; if the page matters, call browser_request_takeover with a one-sentence reason, then end your turn; otherwise report this source as unavailable ("Unavailable: <source> (${VENDOR_NAMES[vendor]} bot protection)") and continue.`;

/** The origin of a page as the engine reports it (a URL, or already an origin); undefined when it reports none. */
function originOf(origin: string | undefined): string | undefined {
  try {
    return origin === undefined ? undefined : new URL(origin).origin;
  } catch {
    return undefined;
  }
}

/** What the bot should do about a sign-in form, by what the vault holds for the page's exact origin. */
function loginWallNote(ctx: BrowserToolContext, origin: string | undefined): string | undefined {
  const exact = originOf(origin);
  if (!exact) return undefined;
  const coverage = ctx.login.coverage(ctx.botId, exact);
  switch (coverage.status) {
    case "granted":
      return `Note from the host: this is a sign-in page and you have a stored credential for it: call browser_login with entry "${coverage.label}".`;
    case "ungranted":
      return `Note from the host: this is a sign-in page. A stored credential "${coverage.label}" exists for it but you have not been granted it: browser_login with entry "${coverage.label}" will ask the owner to approve it, then you end your turn.`;
    case "none":
      return 'Note from the host: source unavailable: this page asks you to sign in and you have no stored credential for it. Do not try to sign in; say so in your report ("Unavailable: <source> (login required)") and continue with the rest of your task.';
  }
}

/** The title of the active tab, to judge a wall that the first call recognised by its title. */
async function activeTitle(ctx: BrowserToolContext): Promise<string | undefined> {
  try {
    const data = (await ctx.browser.call(["tab", "list"])) as {
      tabs?: { title?: string; active?: boolean }[];
    };
    return data.tabs?.find((t) => t.active)?.title;
  } catch (e) {
    if (e instanceof EngineError) return undefined;
    throw e;
  }
}

/**
 * Takes a snapshot of the active tab, numbers its refs, and returns it as untrusted page content. A bot wall
 * (Cloudflare and the like) is looked at again a few times with a pause, inside this call; a page that clears
 * is returned as any other, one that stays comes with a note. A sign-in form comes with a note by vault coverage.
 * The notes are the host's own words, outside the page-content markers.
 */
export async function snapshotOutcome(
  ctx: BrowserToolContext,
  status: string,
  command: string[] = ["snapshot", "-i"],
  title?: string,
): Promise<Outcome> {
  let data = (await ctx.browser.call(command)) as PageData;
  let raw = data.snapshot ?? NO_PAGE;
  let vendor = detectBotWall(raw, title);
  let shownTitle = title;
  for (let i = 0; vendor && i < WALL_RECHECKS; i++) {
    await Bun.sleep(ctx.wallPauseMs);
    data = (await ctx.browser.call(command)) as PageData;
    raw = data.snapshot ?? NO_PAGE;
    // The title the open call returned belongs to the wall; ask for the tab's current one.
    if (title !== undefined) shownTitle = await activeTitle(ctx);
    vendor = detectBotWall(raw, shownTitle);
  }
  const note = vendor
    ? botWallNote(vendor)
    : detectLoginWall(raw, shownTitle)
      ? loginWallNote(ctx, data.origin)
      : undefined;
  const body = `${shownTitle ? `Title: ${shownTitle}\n` : ""}${ctx.page.numberSnapshot(raw)}`;
  return {
    text: `${status}\n\n${note ? `${note}\n\n` : ""}${shapePage({ content: body, origin: data.origin, filesDir: ctx.filesDir })}`,
    page: raw,
  };
}

/** Wraps arbitrary page text (not a snapshot) as untrusted content. */
export function textOutcome(
  ctx: BrowserToolContext,
  status: string,
  content: string,
  origin: string | undefined,
): Outcome {
  return {
    text: `${status}\n\n${shapePage({ content, origin, filesDir: ctx.filesDir })}`,
    page: content,
  };
}

/** Runs a tool body under the loop guard: the 6th identical call that leaves the page unchanged is refused. */
export function pageTool(
  ctx: BrowserToolContext,
  tool: string,
  args: object,
  body: () => Promise<Outcome>,
): Promise<CallToolResult> {
  const key = `${tool}\n${JSON.stringify(args)}`;
  return guarded(async () => {
    ctx.page.checkLoop(key);
    try {
      const outcome = await body();
      ctx.page.record(key, outcome.page);
      return textResult(outcome.text);
    } catch (e) {
      if (e instanceof EngineError || e instanceof ToolError)
        ctx.page.record(key, `error: ${e.message}`);
      throw e;
    }
  });
}
