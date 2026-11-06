import { EngineError } from "./engine-cli.ts";
import type { BrowserRuntimes } from "./runtime.ts";
import type { HumanWaits, WaitingForUser } from "./human-waits.ts";

export type ControlHolder = "bot" | "draining" | "user";

export interface TakeoverOptions {
  runtimes: BrowserRuntimes;
  waits: HumanWaits;
  /** Sends a host message into the bot's session (queued while it is busy). */
  deliver(botId: string, text: string): void;
  /** Control ends after this long without input. Default 30 minutes. */
  inactivityMs?: number;
}

interface Control {
  phase: "draining" | "user";
  /** The bot's takeover request this control answers, if the bot asked for it. */
  waitId?: string;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_INACTIVITY_MS = 30 * 60_000;
const msg = (text: string) => `<browser-control>\n${text}\n</browser-control>`;

/**
 * Who holds a bot's browser. The user takes control from the panel at any time, or the bot asks for it with a
 * human wait; either way new bot calls are refused while the user holds it. It ends on hand-back, on the
 * wait's "I'm done" or "Skip", after 30 minutes without input (counted as Skip), or when the bot's pending
 * waits are cancelled.
 */
export class Takeover {
  private controls = new Map<string, Control>();
  private listeners = new Set<(botId: string, holder: ControlHolder) => void>();
  private inactivityMs: number;

  constructor(private o: TakeoverOptions) {
    this.inactivityMs = o.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  }

  holder(botId: string): ControlHolder {
    return this.controls.get(botId)?.phase ?? "bot";
  }

  /** Tells `listener` whenever a bot's holder changes. */
  subscribe(listener: (botId: string, holder: ControlHolder) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** True while the user holds the browser and may send input. */
  accepts(botId: string): boolean {
    return this.holder(botId) === "user";
  }

  /** The bot asks for help: the user gets control at once and a card with "I'm done" and "Skip". Called from inside a bot call, so it does not wait for the bot's calls to drain. */
  request(botId: string, reason: string): WaitingForUser {
    const browser = this.o.runtimes.forBot(botId);
    const result = this.o.waits.request(botId, {
      kind: "takeover",
      title: "Needs you",
      detail: reason,
      actions: [
        { id: "done", label: "I'm done" },
        { id: "skip", label: "Skip" },
      ],
      onResolve: () => this.release(botId, false),
      resume: (outcome) =>
        outcome === "done"
          ? `The user finished the takeover. The page has probably changed; take a fresh snapshot before continuing.`
          : outcome === "timeout"
            ? `The takeover ended after 30 minutes without input and counts as skipped: the user did not handle "${reason}". Take a fresh snapshot, then continue without it or report what is blocked.`
            : `The user skipped the takeover: they did not handle "${reason}". Take a fresh snapshot, then continue without it or report what is blocked.`,
    });
    browser.holdControl();
    this.begin(botId, { phase: "user", waitId: result.id });
    return result;
  }

  /** The user takes control without a request. Stops new bot calls, waits for the running one, then grants it. */
  async start(botId: string): Promise<void> {
    if (this.controls.has(botId)) return;
    const browser = this.o.runtimes.forBot(botId);
    if (!browser.active()) throw new EngineError("the browser is not running");
    browser.holdControl();
    this.begin(botId, { phase: "draining" });
    try {
      await browser.awaitIdle();
    } catch (e) {
      // Only undo this attempt: a bot request that began meanwhile keeps its control.
      if (this.controls.get(botId)?.phase === "draining") this.release(botId, false);
      throw e;
    }
    const c = this.controls.get(botId);
    if (c?.phase !== "draining") return;
    c.phase = "user";
    this.arm(botId, c);
    this.notify(botId);
  }

  /** The user hands the browser back. Answers the bot's takeover request as done, or tells the bot if its calls were refused. */
  handBack(botId: string): void {
    const c = this.controls.get(botId);
    if (!c) return;
    if (c.waitId && this.o.waits.resolve(c.waitId, "done")) return;
    this.release(botId, true);
  }

  /** The user acted in the browser; control stays for another inactivity period. */
  touch(botId: string): void {
    const c = this.controls.get(botId);
    if (c?.phase === "user") this.arm(botId, c);
  }

  /** The bot's session ended or the bot was deleted: pending waits are cancelled with a message, and control returns without one. */
  cancelBot(botId: string, reason: string): void {
    this.o.waits.cancelBot(botId, reason);
    this.release(botId, false);
  }

  private begin(botId: string, c: Control) {
    this.controls.set(botId, c);
    if (c.phase === "user") this.arm(botId, c);
    this.notify(botId);
  }

  private arm(botId: string, c: Control) {
    clearTimeout(c.timer);
    c.timer = setTimeout(() => this.expire(botId), this.inactivityMs);
    c.timer.unref();
  }

  private expire(botId: string) {
    const c = this.controls.get(botId);
    if (!c) return;
    if (c.waitId && this.o.waits.resolve(c.waitId, "timeout")) return;
    this.release(botId, true);
  }

  /** Returns the browser to the bot; `tell` sends the bot a message if it was refused meanwhile. */
  private release(botId: string, tell: boolean) {
    const c = this.controls.get(botId);
    if (!c) return;
    clearTimeout(c.timer);
    this.controls.delete(botId);
    const refused = this.o.runtimes.forBot(botId).releaseControl();
    this.notify(botId);
    if (tell && refused) this.o.deliver(botId, msg("The user has handed the browser back. Your browser calls during that time were refused with \"user has control\". Take a fresh snapshot before continuing."));
  }

  private notify(botId: string) {
    for (const l of this.listeners) l(botId, this.holder(botId));
  }
}
