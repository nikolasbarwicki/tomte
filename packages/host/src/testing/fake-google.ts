// A fake Google for tests (prior art: fake-telegram.ts): the OAuth consent page and token endpoint, and the Gmail REST routes the built-in
// Gmail tools call, on one loopback origin. `HostServerOptions.google` takes `endpoints`; nothing here ever reaches accounts.google.com,
// oauth2.googleapis.com or gmail.googleapis.com. It records every request (`requests`), so a test can say what the host asked for and with
// which bearer token. To make a route misbehave (a token refusal, a 403, a 429) script it with `respond`; to add a Gmail route, add a case
// in `gmail` below and, for data, a seeding method next to `thread`.

import { createHash, randomBytes } from "node:crypto";

import {
  mailboxWrites,
  type FakeDraft,
  type FakeLabelChange,
  type FakeSent,
} from "./fake-gmail-write.ts";

export type { FakeDraft, FakeLabelChange, FakeSent };

export interface FakeRequest {
  kind: "authorize" | "token" | "gmail";
  method: string;
  /** The path below the origin, such as `/token` or `/gmail/v1/users/me/threads`. */
  path: string;
  query: Record<string, string[]>;
  /** The form a token request carried; test credentials only. */
  form?: Record<string, string>;
  /** The `Authorization` header, if any. */
  authorization?: string;
  /** The JSON body of a Gmail request, if it had one. */
  body?: unknown;
  /** Whether it carried an access token this server issued and has not revoked. */
  authorized: boolean;
  status: number;
}

export interface FakeMessageInput {
  id: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  /** The `Message-ID` header, such as `<m1@mail.example>`. */
  messageId?: string;
  /** The `References` header. */
  references?: string;
  /** Epoch ms; one minute apart in the order given when omitted. */
  at?: number;
  text?: string;
  html?: string;
  snippet?: string;
  attachments?: FakeAttachment[];
}

export interface FakeAttachment {
  filename: string;
  mimeType: string;
  data: string | Uint8Array;
}

export interface FakeGoogle {
  /** The origin, and the three endpoints for `HostServerOptions.google`. */
  readonly url: string;
  readonly endpoints: { authorizationUrl: string; tokenUrl: string; gmailApiBase: string };
  /** The OAuth client the server accepts. */
  readonly client: { id: string; secret: string };
  stop(): Promise<void>;

  /** What the browser does at the consent page: approves the authorization URL and returns the code and state Google redirects back with. */
  approve(authorizeUrl: string): Promise<{ code: string; state: string; redirectUri: string }>;
  /** Makes the next `times` requests whose `"<METHOD> <path>"` starts with `route` answer `status` and `body` instead. */
  respond(route: string, answer: { status: number; body?: unknown }, times?: number): void;
  /** From now on every access token issued so far is refused with 401, as for tokens that expired or were revoked. */
  revokeAccessTokens(): void;
  /** The lifetime in seconds of the access tokens issued from now on; an hour by default. */
  lifetime(seconds: number): void;

  /** Adds a thread to the mailbox, newest last. */
  thread(id: string, messages: FakeMessageInput[]): void;
  /** Adds a user label to the mailbox. */
  label(id: string, name: string): void;
  /** Adds a draft; `mime` is its RFC 2822 text. */
  draft(draft: FakeDraft): void;
  /** Every draft the mailbox holds, those the host created included. */
  drafts(): FakeDraft[];
  /** Ids of the threads moved to the trash. */
  trashed(): string[];
  /** Every label change the host made. */
  labelChanges(): FakeLabelChange[];
  /** Every message and draft the host sent, oldest first. */
  sent(): FakeSent[];

  readonly requests: FakeRequest[];
  /** The Gmail API requests only. */
  gmail(): FakeRequest[];
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

function messageJson(m: FakeMessageInput, threadId: string, at: number, full: boolean) {
  const headers = [
    { name: "From", value: m.from },
    ...(m.to ? [{ name: "To", value: m.to }] : []),
    ...(m.cc ? [{ name: "Cc", value: m.cc }] : []),
    { name: "Subject", value: m.subject },
    ...(m.messageId ? [{ name: "Message-ID", value: m.messageId }] : []),
    ...(m.references ? [{ name: "References", value: m.references }] : []),
    { name: "Date", value: new Date(at).toUTCString() },
  ];
  const parts = [
    ...(m.text !== undefined
      ? [{ mimeType: "text/plain", filename: "", body: { size: m.text.length, data: b64(m.text) } }]
      : []),
    ...(m.html !== undefined
      ? [{ mimeType: "text/html", filename: "", body: { size: m.html.length, data: b64(m.html) } }]
      : []),
  ];
  const files = (m.attachments ?? []).map((a, i) => ({
    partId: String(parts.length + i),
    mimeType: a.mimeType,
    filename: a.filename,
    body: { size: Buffer.from(a.data).length, attachmentId: `att-${m.id}-${i}` },
  }));
  return {
    id: m.id,
    threadId,
    snippet: m.snippet ?? m.text?.slice(0, 80) ?? "",
    internalDate: String(at),
    payload: full
      ? {
          mimeType: "multipart/mixed",
          headers,
          body: { size: 0 },
          parts: [...parts.map((p, i) => ({ ...p, partId: String(i) })), ...files],
        }
      : { mimeType: "multipart/alternative", headers },
  };
}

export function fakeGoogle(o: { clientId?: string; clientSecret?: string } = {}): FakeGoogle {
  const client = {
    id: o.clientId ?? "fake-client.apps.googleusercontent.com",
    secret: o.clientSecret ?? "GOCSPX-fake-secret",
  };
  const requests: FakeRequest[] = [];
  const threads = new Map<string, { messages: FakeMessageInput[]; ats: number[] }>();
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  const scripted: { route: string; status: number; body: unknown; left: number }[] = [];
  let expiresIn = 3600;
  let issued = 0;
  let clock = Date.UTC(2026, 10, 1);

  const findMessage = (id: string) => {
    for (const [thread, t] of threads) {
      const i = t.messages.findIndex((x) => x.id === id);
      if (i >= 0) return { message: t.messages[i]!, thread, at: t.ats[i]! };
    }
    return undefined;
  };
  const write = mailboxWrites({
    hasThread: (id) => threads.has(id),
    hasMessage: (id) => findMessage(id) !== undefined,
  });

  /** An authorization-code answer carries the refresh token; a refresh answer leaves it out, as Google's does. */
  const issue = (refresh?: string) => {
    const token = `ya29.fake-access-${++issued}`;
    accessTokens.add(token);
    return Response.json({
      access_token: token,
      expires_in: expiresIn,
      ...(refresh !== undefined && { refresh_token: refresh }),
      scope: "https://www.googleapis.com/auth/gmail.modify",
      token_type: "Bearer",
    });
  };
  const failure = (status: number, error: string) => Response.json({ error }, { status });
  const googleError = (status: number, message: string, reason: string) =>
    Response.json({ error: { code: status, message, errors: [{ message, reason }] } }, { status });

  function token(form: Record<string, string>): Response {
    if (form.client_id !== client.id || form.client_secret !== client.secret)
      return failure(401, "invalid_client");
    if (form.grant_type === "refresh_token") {
      const refresh = form.refresh_token ?? "";
      return refreshTokens.has(refresh) ? issue() : failure(400, "invalid_grant");
    }
    const code = codes.get(form.code ?? "");
    codes.delete(form.code ?? "");
    const verified =
      code &&
      form.redirect_uri === code.redirectUri &&
      createHash("sha256")
        .update(form.code_verifier ?? "")
        .digest("base64url") === code.challenge;
    if (!verified) return failure(400, "invalid_grant");
    const refresh = `1//fake-refresh-${++issued}`;
    refreshTokens.add(refresh);
    return issue(refresh);
  }

  function gmail(
    req: Request,
    path: string,
    query: URLSearchParams,
    authorized: boolean,
    body: unknown,
  ): Response {
    if (!authorized) return googleError(401, "Invalid Credentials", "authError");
    const m = /^\/gmail\/v1\/users\/me\/(threads)(?:\/([^/]+))?$/.exec(path);
    if (m && req.method === "GET" && m[2] === undefined) {
      const q = (query.get("q") ?? "").toLowerCase();
      const found = [...threads].filter(
        ([id, t]) =>
          !q ||
          id.includes(q) ||
          t.messages.some((x) =>
            `${x.subject} ${x.from} ${x.text ?? ""}`.toLowerCase().includes(q),
          ),
      );
      const max = Number(query.get("maxResults") ?? 100);
      return Response.json({
        threads: found
          .slice(0, max)
          .map(([id, t]) => ({ id, snippet: t.messages.at(-1)?.snippet ?? "" })),
        resultSizeEstimate: found.length,
        ...(found.length > max && { nextPageToken: "page-2" }),
      });
    }
    if (m && req.method === "GET" && m[2] !== undefined) {
      const id = decodeURIComponent(m[2]);
      const t = threads.get(id);
      if (!t) return googleError(404, "Requested entity was not found.", "notFound");
      const full = query.get("format") === "full";
      return Response.json({
        id,
        messages: t.messages.map((x, i) => messageJson(x, id, t.ats[i]!, full)),
      });
    }
    const msg = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)(?:\/attachments\/([^/]+))?$/.exec(path);
    if (msg && req.method === "GET") {
      const id = decodeURIComponent(msg[1]!);
      const found = findMessage(id);
      if (!found) return googleError(404, "Requested entity was not found.", "notFound");
      if (msg[2] === undefined)
        return Response.json(
          messageJson(found.message, found.thread, found.at, query.get("format") === "full"),
        );
      const att = found.message.attachments?.find(
        (_, i) => `att-${id}-${i}` === decodeURIComponent(msg[2]!),
      );
      if (!att) return googleError(404, "Requested entity was not found.", "notFound");
      return Response.json({
        size: Buffer.from(att.data).length,
        data: Buffer.from(att.data).toString("base64url"),
      });
    }
    return write.handle(req.method, path, query, body) ?? googleError(404, "Not Found", "notFound");
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const form: Record<string, string> =
        req.method === "POST" && u.pathname === "/token"
          ? Object.fromEntries(new URLSearchParams(await req.text()))
          : {};
      const query: Record<string, string[]> = {};
      for (const [k, v] of u.searchParams) (query[k] ??= []).push(v);
      const bearer = req.headers.get("authorization") ?? undefined;
      let json: unknown;
      if (req.method === "POST" || req.method === "PUT") {
        const text = u.pathname === "/token" ? "" : await req.text();
        json = text ? JSON.parse(text) : undefined;
      }
      const kind =
        u.pathname === "/token"
          ? "token"
          : u.pathname === "/o/oauth2/v2/auth"
            ? "authorize"
            : "gmail";
      const entry: FakeRequest = {
        kind,
        method: req.method,
        path: u.pathname,
        query,
        ...(kind === "token" && { form }),
        ...(kind === "gmail" && json !== undefined && { body: json }),
        ...(bearer !== undefined && { authorization: bearer }),
        authorized: bearer !== undefined && accessTokens.has(bearer.replace(/^Bearer /, "")),
        status: 0,
      };
      requests.push(entry);
      const script = scripted.find(
        (s) => s.left > 0 && `${req.method} ${u.pathname}`.startsWith(s.route),
      );
      let res: Response;
      if (script) {
        script.left--;
        res = Response.json(script.body ?? {}, { status: script.status });
      } else if (kind === "token") res = token(form);
      else if (kind === "authorize") {
        const ok =
          u.searchParams.get("client_id") === client.id &&
          u.searchParams.get("response_type") === "code" &&
          u.searchParams.get("code_challenge_method") === "S256" &&
          u.searchParams.has("code_challenge");
        const redirectUri = u.searchParams.get("redirect_uri") ?? "";
        if (!ok || !redirectUri) res = new Response("bad authorization request", { status: 400 });
        else {
          const code = `fake-code-${randomBytes(6).toString("hex")}`;
          codes.set(code, {
            challenge: u.searchParams.get("code_challenge")!,
            redirectUri,
          });
          const back = new URL(redirectUri);
          back.searchParams.set("code", code);
          back.searchParams.set("state", u.searchParams.get("state") ?? "");
          res = new Response(null, { status: 302, headers: { location: back.toString() } });
        }
      } else res = gmail(req, u.pathname, u.searchParams, entry.authorized, json);
      entry.status = res.status;
      return res;
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    endpoints: {
      authorizationUrl: `${url}/o/oauth2/v2/auth`,
      tokenUrl: `${url}/token`,
      gmailApiBase: `${url}/gmail/v1`,
    },
    client,
    stop: () => server.stop(true),
    async approve(authorizeUrl) {
      const res = await fetch(authorizeUrl, { redirect: "manual" });
      const location = res.headers.get("location");
      if (res.status !== 302 || !location)
        throw new Error(`the fake consent page refused the request (${res.status})`);
      const back = new URL(location);
      return {
        code: back.searchParams.get("code")!,
        state: back.searchParams.get("state")!,
        redirectUri: `${back.origin}${back.pathname}`,
      };
    },
    respond(route, answer, times = 1) {
      scripted.push({ route, status: answer.status, body: answer.body, left: times });
    },
    revokeAccessTokens: () => accessTokens.clear(),
    lifetime(seconds) {
      expiresIn = seconds;
    },
    thread(id, messages) {
      threads.set(id, { messages, ats: messages.map((m) => m.at ?? (clock += 60_000)) });
    },
    label: write.addLabel,
    draft: write.addDraft,
    drafts: write.drafts,
    trashed: write.trashed,
    labelChanges: write.labelChanges,
    sent: write.sent,
    requests,
    gmail: () => requests.filter((r) => r.kind === "gmail"),
  };
}
