// A fake Telegram Bot API server for tests (prior art: fake-oauth-server.ts): `getMe`, `getUpdates` with real long-poll behaviour (it holds the
// call until an update arrives, the timeout passes or the client aborts, and drops what an `offset` confirms), `sendMessage`, `editMessageText`
// and `answerCallbackQuery`, on a loopback port. It records every call, so a test can say what the host sent and, as important, what it did not.
// The token it accepts is `123:fake-token` unless a test names another; every other token is refused with 401 (404 when it is not even shaped like one).
// `HostServerOptions.telegram.baseUrl` points the adapter at `url`; nothing here ever reaches api.telegram.org.

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

export interface FakeCall {
  method: string;
  /** The token the call carried, and when it arrived. */
  token: string;
  at: number;
  /** Whether the token is one the server accepted at that moment. */
  authorized: boolean;
  params: Record<string, unknown>;
  /** The HTTP status the server answered; 200 for a call it served. */
  status: number;
  /** The id the server gave a `sendMessage` it served, which a button press or a reply names. */
  messageId?: number;
}

type Update = Record<string, unknown> & { update_id: number };

export interface FakeTelegram {
  /** The API's origin, for `HostServerOptions.telegram.baseUrl`. */
  readonly url: string;
  /** The token the server accepts and the bot username it reports. */
  readonly token: string;
  readonly username: string;
  stop(): Promise<void>;

  /** A message from `from` in a private chat with them (or in a chat of another `chatType`); returns the update id. */
  message(
    from: TelegramUser,
    text: string,
    options?: { chatType?: string; replyTo?: number; chatId?: number },
  ): number;
  /** A button press on message `on` of the private chat with `from`; returns the update id. */
  press(from: TelegramUser, data: string, on: number): number;
  /** An edited message, the way Telegram reports one when the update kind is allowed. */
  editedMessage(from: TelegramUser, text: string): number;
  /** An update of any shape. */
  push(update: Record<string, unknown>): number;

  /** From now on calls with this token (the default one when omitted) are answered 401, as for a revoked token. */
  revoke(token?: string): void;
  /** From now on this token is accepted too. */
  allow(token: string): void;
  /** From now on `getUpdates` answers 409, as when another poller or a webhook holds the bot; false ends it. */
  conflict(on?: boolean): void;
  /** The next `n` `sendMessage` calls answer 429 asking to wait `retryAfter` seconds. */
  rateLimit(n: number, retryAfter: number): void;
  /** Makes every handled update unconfirmed again, as if the offset that confirmed them never reached Telegram. */
  forgetConfirmations(): void;

  /** Every call so far, `getMe` and `getUpdates` included, oldest first. */
  readonly calls: FakeCall[];
  /** The calls a person would see the effect of: everything but `getMe` and `getUpdates`. */
  outgoing(): FakeCall[];
  /** The `text` of every message sent, in order. */
  texts(): string[];
  /** Calls of one method. */
  of(method: string): FakeCall[];
}

export function fakeTelegram(o: { token?: string; username?: string } = {}): FakeTelegram {
  const token = o.token ?? "123:fake-token";
  const username = o.username ?? "fake_claudebot";
  const calls: FakeCall[] = [];
  /** Updates not yet confirmed, and the ones an offset confirmed (kept so `forgetConfirmations` can bring them back). */
  let pending: Update[] = [];
  let confirmed: Update[] = [];
  let nextUpdate = 1;
  let nextMessage = 1000;
  const valid = new Set([token]);
  let conflicting = false;
  let limited = { remaining: 0, retryAfter: 0 };
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const w of waiters) w();
  };

  const reply = (body: object, status = 200) => Response.json(body, { status });
  const failure = (code: number, description: string, parameters?: object) =>
    reply({ ok: false, error_code: code, description, ...(parameters && { parameters }) }, code);
  const ok = (result: unknown) => reply({ ok: true, result });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const m = /^\/bot([^/]*)\/(\w+)$/.exec(new URL(req.url).pathname);
      if (!m || req.method !== "POST") return new Response("nope", { status: 404 });
      const [, sent, method] = m as unknown as [string, string, string];
      const params = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const authorized = valid.has(sent);
      const call: FakeCall = { method, token: sent, at: Date.now(), authorized, params, status: 0 };
      calls.push(call);
      const answer = async (): Promise<Response> => {
        if (!authorized)
          return sent.includes(":") ? failure(401, "Unauthorized") : failure(404, "Not Found");

        switch (method) {
          case "getMe":
            return ok({ id: 1, is_bot: true, first_name: "Claudebot", username });
          case "getUpdates": {
            if (conflicting)
              return failure(
                409,
                "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
              );
            const offset = typeof params.offset === "number" ? params.offset : 0;
            confirmed.push(...pending.filter((u) => u.update_id < offset));
            pending = pending.filter((u) => u.update_id >= offset);
            if (pending.length === 0) {
              const seconds = typeof params.timeout === "number" ? params.timeout : 0;
              const { promise, resolve } = Promise.withResolvers<void>();
              const timer = setTimeout(resolve, seconds * 1000);
              waiters.add(resolve);
              req.signal.addEventListener("abort", () => resolve());
              await promise;
              clearTimeout(timer);
              waiters.delete(resolve);
              if (req.signal.aborted) return new Response(null, { status: 499 });
            }
            return ok(pending.filter((u) => u.update_id >= offset));
          }
          case "sendMessage": {
            if (limited.remaining > 0) {
              limited.remaining--;
              return failure(429, "Too Many Requests: retry later", {
                retry_after: limited.retryAfter,
              });
            }
            call.messageId = nextMessage++;
            return ok({
              message_id: call.messageId,
              chat: { id: params.chat_id, type: "private" },
              text: params.text,
            });
          }
          case "editMessageText":
            return ok({
              message_id: params.message_id,
              chat: { id: params.chat_id },
              text: params.text,
            });
          case "answerCallbackQuery":
            return ok(true);
        }
        return failure(404, "Not Found: method not found");
      };
      const response = await answer();
      call.status = response.status;
      return response;
    },
  });

  const push = (update: Record<string, unknown>) => {
    const full = { update_id: nextUpdate++, ...update } as Update;
    pending.push(full);
    wake();
    return full.update_id;
  };
  const chatOf = (from: TelegramUser) => ({ id: from.id, type: "private" });

  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    username,
    stop: async () => {
      wake();
      await server.stop(true);
    },
    message: (from, text, opts = {}) =>
      push({
        message: {
          message_id: nextMessage++,
          from,
          chat: {
            ...chatOf(from),
            ...(opts.chatType && { type: opts.chatType }),
            ...(opts.chatId !== undefined && { id: opts.chatId }),
          },
          date: 0,
          text,
          ...(opts.replyTo !== undefined && {
            reply_to_message: { message_id: opts.replyTo, chat: chatOf(from), date: 0 },
          }),
        },
      }),
    press: (from, data, on) =>
      push({
        callback_query: {
          id: `cb-${nextUpdate}`,
          from,
          chat_instance: "ci",
          data,
          message: { message_id: on, chat: chatOf(from), date: 0 },
        },
      }),
    editedMessage: (from, text) =>
      push({
        edited_message: { message_id: nextMessage++, from, chat: chatOf(from), date: 0, text },
      }),
    push,
    revoke(t = token) {
      valid.delete(t);
      wake();
    },
    allow(t) {
      valid.add(t);
    },
    conflict(on = true) {
      conflicting = on;
      wake();
    },
    rateLimit(n, retryAfter) {
      limited = { remaining: n, retryAfter };
    },
    forgetConfirmations() {
      pending = [...confirmed, ...pending].sort((a, b) => a.update_id - b.update_id);
      confirmed = [];
      wake();
    },
    calls,
    outgoing: () => calls.filter((c) => c.method !== "getMe" && c.method !== "getUpdates"),
    texts: () =>
      calls
        .filter((c) => c.method === "sendMessage" && c.status === 200)
        .map((c) => String(c.params.text)),
    of: (method) => calls.filter((c) => c.method === method),
  };
}
