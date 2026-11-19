// The Gmail routes of the fake Google that change the mailbox or list what it holds beside threads: labels, drafts, label changes and
// trash. `fakeGoogle` asks `handle` before it answers 404, and exposes `state` to tests, so a test says what the mailbox looks like
// afterwards instead of decoding request bodies.

export interface FakeDraft {
  id: string;
  threadId?: string;
  /** The RFC 2822 text Gmail was given, decoded from `raw`. */
  mime: string;
}

export interface FakeLabelChange {
  kind: "thread" | "message";
  id: string;
  add: string[];
  remove: string[];
}

/** A message or draft the host sent. `mime` is the message's RFC 2822 text; empty for a draft, which Gmail holds. */
export interface FakeSent {
  via: "messages" | "drafts";
  /** The `threadId` the request named. */
  threadId?: string;
  /** The draft's id when `via` is `drafts`. */
  draftId?: string;
  mime: string;
}

const SYSTEM = ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "TRASH", "SPAM"];

const googleError = (status: number, message: string, reason: string) =>
  Response.json({ error: { code: status, message, errors: [{ message, reason }] } }, { status });

/** The headers and decoded body of RFC 2822 text, enough for a draft's metadata. */
function parseMime(mime: string): { headers: { name: string; value: string }[]; body: string } {
  const [head = "", ...rest] = mime.split("\r\n\r\n");
  const headers = head
    .replace(/\r\n[ \t]+/g, " ")
    .split("\r\n")
    .map((line) => {
      const i = line.indexOf(":");
      return { name: line.slice(0, i), value: line.slice(i + 1).trim() };
    });
  const raw = rest.join("\r\n\r\n");
  const base64 = headers.some(
    (h) => h.name.toLowerCase() === "content-transfer-encoding" && h.value === "base64",
  );
  return { headers, body: base64 ? Buffer.from(raw, "base64").toString("utf8") : raw };
}

export function mailboxWrites(env: {
  hasThread(id: string): boolean;
  hasMessage(id: string): boolean;
}) {
  const labels = new Map<string, { name: string; type: "system" | "user" }>([
    ...SYSTEM.map((id) => [id, { name: id, type: "system" as const }] as const),
    ["Label_1", { name: "Receipts", type: "user" as const }],
  ]);
  const drafts = new Map<string, FakeDraft>();
  const sent: FakeSent[] = [];
  const trashed: string[] = [];
  const labelChanges: FakeLabelChange[] = [];
  let next = 0;

  function draftJson(d: FakeDraft, format: string | null) {
    const { headers, body } = parseMime(d.mime);
    const keep =
      format === "metadata" ? headers.filter((h) => /^(to|subject)$/i.test(h.name)) : headers;
    return {
      id: d.id,
      message: {
        id: `${d.id}-message`,
        threadId: d.threadId ?? `${d.id}-thread`,
        snippet: body.slice(0, 80),
        payload: {
          mimeType: "text/plain",
          headers: keep,
          ...(format !== "metadata" && { body: { data: Buffer.from(body).toString("base64url") } }),
        },
      },
    };
  }

  function saveDraft(id: string, body: unknown): Response {
    const message = (body as { message?: { raw?: string; threadId?: string } } | undefined)
      ?.message;
    if (!message?.raw) return googleError(400, "Invalid message", "invalidArgument");
    const draft: FakeDraft = {
      id,
      ...(message.threadId !== undefined && { threadId: message.threadId }),
      mime: Buffer.from(message.raw, "base64url").toString("utf8"),
    };
    drafts.set(id, draft);
    return Response.json(draftJson(draft, null));
  }

  function handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
  ): Response | undefined {
    const m = /^\/gmail\/v1\/users\/me\/(.*)$/.exec(path);
    const route = m?.[1];
    if (route === undefined) return undefined;
    if (method === "GET" && route === "labels")
      return Response.json({ labels: [...labels].map(([id, l]) => ({ id, ...l })) });
    if (method === "GET" && route === "drafts") {
      const max = Number(query.get("maxResults") ?? 100);
      const all = [...drafts.values()];
      return Response.json({
        drafts: all.slice(0, max).map((d) => ({ id: d.id, message: { id: `${d.id}-message` } })),
        ...(all.length > max && { nextPageToken: "drafts-2" }),
      });
    }
    if (method === "POST" && route === "messages/send") {
      const message = body as { raw?: unknown; threadId?: string } | undefined;
      if (typeof message?.raw !== "string")
        return googleError(400, "Invalid value for raw", "invalidArgument");
      if (message.threadId !== undefined && !env.hasThread(message.threadId))
        return googleError(404, "Requested entity was not found.", "notFound");
      sent.push({
        via: "messages",
        ...(message.threadId !== undefined && { threadId: message.threadId }),
        mime: Buffer.from(message.raw, "base64url").toString("utf8"),
      });
      return Response.json({
        id: `sent-${sent.length}`,
        threadId: message.threadId ?? `sent-thread-${sent.length}`,
        labelIds: ["SENT"],
      });
    }
    if (method === "POST" && route === "drafts/send") {
      const id = (body as { id?: string } | undefined)?.id ?? "";
      const draft = drafts.get(id);
      if (!draft) return googleError(404, "Requested entity was not found.", "notFound");
      drafts.delete(id);
      sent.push({
        via: "drafts",
        draftId: id,
        ...(draft.threadId !== undefined && { threadId: draft.threadId }),
        mime: "",
      });
      return Response.json({
        id: `sent-${sent.length}`,
        threadId: draft.threadId ?? `sent-thread-${sent.length}`,
        labelIds: ["SENT"],
      });
    }
    if (method === "POST" && route === "drafts") return saveDraft(`r-draft-${++next}`, body);
    const draft = /^drafts\/([^/]+)$/.exec(route);
    if (draft) {
      const id = decodeURIComponent(draft[1]!);
      const found = drafts.get(id);
      if (!found) return googleError(404, "Requested entity was not found.", "notFound");
      if (method === "GET") return Response.json(draftJson(found, query.get("format")));
      if (method === "PUT") return saveDraft(id, body);
    }
    const target = /^(threads|messages)\/([^/]+)\/(modify|trash)$/.exec(route);
    if (method === "POST" && target) {
      const kind = target[1] === "threads" ? "thread" : "message";
      const id = decodeURIComponent(target[2]!);
      if (!(kind === "thread" ? env.hasThread(id) : env.hasMessage(id)))
        return googleError(404, "Requested entity was not found.", "notFound");
      if (target[3] === "trash") {
        trashed.push(id);
        return Response.json({ id });
      }
      const change = body as { addLabelIds?: string[]; removeLabelIds?: string[] };
      const unknown = [...(change.addLabelIds ?? []), ...(change.removeLabelIds ?? [])].find(
        (l) => !labels.has(l),
      );
      if (unknown !== undefined)
        return googleError(400, `Invalid label: ${unknown}`, "invalidArgument");
      labelChanges.push({
        kind,
        id,
        add: change.addLabelIds ?? [],
        remove: change.removeLabelIds ?? [],
      });
      return Response.json({ id });
    }
    return undefined;
  }

  return {
    handle,
    addLabel: (id: string, name: string) => void labels.set(id, { name, type: "user" }),
    addDraft: (draft: FakeDraft) => void drafts.set(draft.id, draft),
    drafts: () => [...drafts.values()],
    sent: () => [...sent],
    trashed: () => [...trashed],
    labelChanges: () => [...labelChanges],
  };
}
