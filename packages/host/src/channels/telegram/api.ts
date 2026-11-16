import { z } from "zod";

/** Telegram refused a call. `status` is its error code (the HTTP status when the body has none); `retryAfter` is the seconds a 429 asks to wait. Never carries the URL, so never the token. */
export class TelegramError extends Error {
  constructor(
    readonly status: number,
    description: string,
    readonly retryAfter?: number,
  ) {
    super(description);
  }
}

/** Telegram could not be reached at all (no connection, no HTTP answer). The message is fixed text: the underlying error names the URL, which holds the token. */
export class TelegramUnreachable extends Error {
  constructor() {
    super("cannot reach Telegram");
  }
}

const Envelope = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

const Me = z.object({ username: z.string().min(1) });
const Sent = z.object({ message_id: z.number(), chat: z.object({ id: z.number() }) });

/** The five Bot API methods the adapter uses. A webhook (Stage 3) replaces `getUpdates` and nothing else. */
export interface TelegramApi {
  getMe(signal?: AbortSignal): Promise<{ username: string }>;
  /** Raw updates: the loop reads their ids before judging their shape, so one it cannot read is still confirmed. */
  getUpdates(
    p: { offset?: number | undefined; timeout: number },
    signal: AbortSignal,
  ): Promise<unknown[]>;
  sendMessage(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ chatId: number; messageId: number }>;
  editMessageText(params: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  answerCallbackQuery(params: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
}

/** The update kinds the adapter asks for; Telegram sends nothing else, edited messages included. */
const ALLOWED_UPDATES = ["message", "callback_query"];

export function createTelegramApi(o: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}): TelegramApi {
  const doFetch = o.fetch ?? fetch;
  const base = `${o.baseUrl.replace(/\/+$/, "")}/bot${o.token}`;

  async function call(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        ...(signal && { signal }),
      });
    } catch (e) {
      // An abort is the caller's own doing and passes through; anything else is the network, described without its URL.
      if (signal?.aborted) throw e;
      throw new TelegramUnreachable();
    }
    let envelope: z.infer<typeof Envelope> | undefined;
    try {
      envelope = Envelope.parse(await res.json());
    } catch {
      // Not Telegram's JSON (a proxy, an error page): the HTTP status is all there is.
    }
    if (!res.ok || !envelope?.ok)
      throw new TelegramError(
        envelope?.error_code ?? res.status,
        envelope?.description ?? `HTTP ${res.status}`,
        envelope?.parameters?.retry_after,
      );
    return envelope.result;
  }

  return {
    async getMe(signal) {
      return Me.parse(await call("getMe", {}, signal));
    },
    async getUpdates(p, signal) {
      const result = await call(
        "getUpdates",
        {
          ...(p.offset !== undefined && { offset: p.offset }),
          timeout: p.timeout,
          allowed_updates: ALLOWED_UPDATES,
        },
        signal,
      );
      return z.array(z.unknown()).parse(result);
    },
    async sendMessage(params, signal) {
      const sent = Sent.parse(await call("sendMessage", params, signal));
      return { chatId: sent.chat.id, messageId: sent.message_id };
    },
    async editMessageText(params, signal) {
      await call("editMessageText", params, signal);
    },
    async answerCallbackQuery(params, signal) {
      await call("answerCallbackQuery", params, signal);
    },
  };
}
