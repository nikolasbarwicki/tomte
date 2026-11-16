import type { ChannelStatus } from "@claudebot/contract/api";

import { channelTokenSecretName, type SecretStore } from "../../platform/secrets.ts";
import type { Channel, Receive } from "../types.ts";
import { createTelegramApi, TelegramError, TelegramUnreachable, type TelegramApi } from "./api.ts";
import {
  callsOf,
  editParams,
  inboundOf,
  parseRef,
  refOf,
  sendParams,
  updateId,
} from "./mapping.ts";
import type { Call } from "./mapping.ts";

const KIND = "telegram";

export interface TelegramOptions {
  /** The Bot API's origin; `https://api.telegram.org` when omitted. Tests point it at a fake server. */
  baseUrl?: string;
  /** The `timeout` of each `getUpdates` call in seconds; 50 when omitted. */
  pollTimeoutSeconds?: number;
  /** The least time between two sends, which Telegram asks to be about a second per chat; 1000 ms when omitted. */
  sendSpacingMs?: number;
  /** The first wait after a failed call; it doubles up to 30 times as much. 1000 ms when omitted. */
  backoffMs?: number;
}

export interface TelegramDeps {
  secrets: SecretStore;
  /** `Channels.receive`: where every update goes. */
  receive: Receive;
  options?: TelegramOptions;
  /** For tests that need to see the wire; the global `fetch` when omitted. */
  fetch?: typeof fetch;
}

/** How many times a 429 is waited out and retried before the send fails. */
const MAX_RATE_LIMIT_RETRIES = 5;
const BACKOFF_CEILING_FACTOR = 30;

const REJECTED = "the bot token was rejected";
const CONFLICT = "another process polls this bot or a webhook is set";

/** Resolves after `ms`, or at once when `signal` aborts; the caller checks the signal. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done);
  if (signal.aborted) done();
  return promise;
}

/** Why a call failed, in words for the Channels page; never anything that could hold the token. */
function describe(e: unknown): string {
  if (e instanceof TelegramError)
    return e.status === 409 ? CONFLICT : `Telegram refused the request (${e.status})`;
  if (e instanceof TelegramUnreachable) return "cannot reach Telegram; retrying";
  return "unexpected answer from Telegram; retrying";
}

/**
 * The Telegram adapter: a long-polling loop over the Bot API that hands each update to `receive` and carries out its reply, and a spaced sender
 * for what the host sends on its own. The token is read from the secrets backend when the channel starts and replaced through `setToken`.
 * Nothing here logs or returns the token.
 */
export function createTelegramChannel(d: TelegramDeps): Channel {
  const baseUrl = d.options?.baseUrl ?? "https://api.telegram.org";
  const pollTimeout = d.options?.pollTimeoutSeconds ?? 50;
  const spacing = d.options?.sendSpacingMs ?? 1000;
  const backoff = d.options?.backoffMs ?? 1000;
  const connect = (token: string) => createTelegramApi({ baseUrl, token, ...optional(d.fetch) });

  let started = false;
  /** Aborts every send and wait of this start; replaced by `start`. */
  let lifetime = new AbortController();
  /** Bumped by every start, stop and token change, so a slow read of the token does not start a loop nobody wants any more. */
  let epoch = 0;
  let api: TelegramApi | undefined;
  let loop: { abort: AbortController; done: Promise<void> } | undefined;
  let status: ChannelStatus = { state: "unconfigured", detail: null, username: null };
  let lastLogged: string | null = null;

  const setStatus = (next: Partial<ChannelStatus>) => {
    status = { ...status, ...next };
    if (status.state === "failed" && status.detail !== lastLogged)
      console.error(`[telegram] ${status.detail}`);
    lastLogged = status.state === "failed" ? status.detail : null;
  };

  // The sender: one call at a time, in order, at least `spacing` apart; a 429 is waited out and the call retried.
  let tail: Promise<unknown> = Promise.resolve();
  let lastCallAt = 0;
  function limited<T>(call: (a: TelegramApi, signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = lifetime.signal;
    const job = tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = lastCallAt + spacing - Date.now();
        if (wait > 0) await sleep(wait, signal);
        signal.throwIfAborted();
        if (!api) throw new Error("Telegram has no bot token yet");
        lastCallAt = Date.now();
        try {
          return await call(api, signal);
        } catch (e) {
          if (
            !(e instanceof TelegramError) ||
            e.status !== 429 ||
            e.retryAfter === undefined ||
            attempt >= MAX_RATE_LIMIT_RETRIES
          )
            throw e;
          await sleep(e.retryAfter * 1000, signal);
          signal.throwIfAborted();
        }
      }
    });
    tail = job.catch(() => undefined);
    return job;
  }

  async function execute(call: Call) {
    // A toast is not a message: it is not spaced, so a button press is answered at once.
    if (call.method === "answerCallbackQuery")
      return api?.answerCallbackQuery(call.params, lifetime.signal);
    if (call.method === "editMessageText")
      return limited((a, s) => a.editMessageText(call.params, s));
    return void (await limited((a, s) => a.sendMessage(call.params, s)));
  }

  async function handle(raw: unknown) {
    const served = inboundOf(raw);
    if (!served) return;
    const reply = await d.receive(KIND, served.inbound);
    for (const call of callsOf(reply, served)) await execute(call);
  }

  async function poll(a: TelegramApi, signal: AbortSignal, known: string | null) {
    let username = known;
    let offset: number | undefined;
    let delay = backoff;
    let recovering = false;
    if (known !== null) setStatus({ state: "running", detail: null });
    while (!signal.aborted) {
      try {
        if (username === null) {
          username = (await a.getMe(signal)).username;
          setStatus({ state: "running", detail: null, username });
        }
        // After a failure the next call returns at once: a long poll would hide for up to a minute that the failure is over.
        const timeout = recovering ? 0 : pollTimeout;
        const updates = await a.getUpdates({ offset, timeout }, signal);
        recovering = false;
        setStatus({ state: "running", detail: null });
        delay = backoff;
        for (const raw of updates) {
          try {
            await handle(raw);
          } catch (e) {
            if (signal.aborted) return;
            console.error(
              `[telegram] handling an update failed: ${e instanceof Error ? e.message : "unknown error"}`,
            );
          }
          // An update stopped halfway is left unconfirmed; Telegram sends it again after a restart.
          if (signal.aborted) return;
          const id = updateId(raw);
          if (id !== undefined) offset = Math.max(offset ?? 0, id + 1);
        }
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof TelegramError && e.status === 401) {
          setStatus({ state: "failed", detail: REJECTED });
          return;
        }
        setStatus({ state: "failed", detail: describe(e) });
        recovering = true;
        await sleep(delay, signal);
        delay = Math.min(delay * 2, backoff * BACKOFF_CEILING_FACTOR);
      }
    }
  }

  async function halt() {
    loop?.abort.abort();
    await loop?.done;
    loop = undefined;
  }

  async function begin(token: string, username: string | null) {
    epoch++;
    await halt();
    const a = connect(token);
    api = a;
    setStatus({ state: "starting", detail: null, username });
    const abort = new AbortController();
    loop = { abort, done: poll(a, abort.signal, username) };
  }

  return {
    kind: KIND,

    start() {
      started = true;
      lifetime = new AbortController();
      const mine = ++epoch;
      void d.secrets.get(channelTokenSecretName(KIND)).then(
        (token) => {
          if (mine !== epoch || !started) return;
          if (token === null) return setStatus({ state: "unconfigured", detail: null });
          return begin(token, null);
        },
        () => setStatus({ state: "failed", detail: "the bot token could not be read" }),
      );
    },

    async stop() {
      started = false;
      epoch++;
      lifetime.abort();
      await halt();
      await tail;
      api = undefined;
    },

    async send(to, message) {
      const chatId = Number(to.id);
      if (!Number.isSafeInteger(chatId)) throw new Error(`not a Telegram account: ${to.id}`);
      const sent = await limited((a, s) => a.sendMessage(sendParams(chatId, message), s));
      return refOf(sent.chatId, sent.messageId);
    },

    async edit(ref, message) {
      const parsed = parseRef(ref);
      if (!parsed) throw new Error(`not a Telegram message: ${ref}`);
      await limited((a, s) => a.editMessageText(editParams(parsed, message), s));
    },

    status: () => ({ ...status }),

    linkUrl: (code) =>
      status.username === null ? undefined : `https://t.me/${status.username}?start=${code}`,

    async setToken(token) {
      let username: string;
      try {
        username = (await connect(token).getMe()).username;
      } catch (e) {
        // Telegram answers an unknown token with 401, a malformed one with 404.
        const refused = e instanceof TelegramError && (e.status === 401 || e.status === 404);
        return { ok: false, reason: refused ? "rejected" : "unreachable" };
      }
      await d.secrets.set(channelTokenSecretName(KIND), token);
      if (started) await begin(token, username);
      return { ok: true };
    },
  };
}

/** `{ fetch }` when there is one, so an absent `fetch` is not passed as an explicit undefined. */
function optional(f: typeof fetch | undefined): { fetch?: typeof fetch } {
  return f ? { fetch: f } : {};
}
