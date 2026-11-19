const REQUEST_TIMEOUT_MS = 30_000;

type Query = Record<string, string | number | readonly string[] | undefined>;

interface GmailRequest {
  /** Relative to `users/me/`, such as `threads` or `threads/<id>`. */
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Query;
  body?: unknown;
}

/** The Gmail REST API as a tool sees it: one call per request, the answer parsed as JSON. */
export interface GmailApi {
  /** `op` names the operation in the log, such as `threads.get`; `ref` is a message or thread id worth logging with it. */
  call(op: string, req: GmailRequest, ref?: string): Promise<unknown>;
}

/** A Gmail API failure. `message` is safe to show a bot: Google's text without URLs or token-like strings. */
export class GmailError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Google's machine-readable reason, such as `rateLimitExceeded` or `insufficientPermissions`. */
    readonly reason?: string,
  ) {
    super(message);
  }

  /** The sign-in itself is the problem: Gmail rejected the token, or the grant lacks a scope a tool needs. Only a new sign-in helps. */
  get signInLost(): boolean {
    return (
      this.status === 401 || (this.status === 403 && this.reason === "insufficientPermissions")
    );
  }
}

/** URLs and token-like strings never reach a bot through an error message. */
const URL_OR_TOKEN = /https?:\/\/\S+|\bya29\.[\w.-]+|\b[\w-]{40,}\b/g;

async function failure(res: Response): Promise<GmailError> {
  let message: string | undefined;
  let reason: string | undefined;
  try {
    const body = (await res.json()) as {
      error?: { message?: unknown; errors?: { reason?: unknown }[] };
    };
    if (typeof body.error?.message === "string")
      message = body.error.message.replace(URL_OR_TOKEN, "[removed]").slice(0, 300);
    const first = body.error?.errors?.[0]?.reason;
    if (typeof first === "string") reason = first;
  } catch {
    // An answer that is not JSON gets the generic text for its status.
  }
  return new GmailError(
    res.status,
    message ??
      (res.status === 401
        ? "Gmail rejected the sign-in"
        : res.status === 404
          ? "not found"
          : res.status === 429
            ? "Gmail's rate limit was reached; try again later"
            : `Gmail answered with status ${res.status}`),
    reason,
  );
}

/**
 * The Gmail API over `fetch`. The bearer token comes from `accessToken` on every request, so a refreshed token is used at once;
 * a 401 asks for a new token once (passing the rejected one) and repeats the request. It logs the operation, the status and the id
 * the operation named, never an address, a subject or a body.
 */
export function createGmailApi(o: {
  base: string;
  accessToken: (rejected?: string) => Promise<string>;
  log: (line: string) => void;
}): GmailApi {
  return {
    async call(op, req, ref) {
      const url = new URL(`${o.base}/users/me/${req.path}`);
      for (const [k, v] of Object.entries(req.query ?? {}))
        for (const x of Array.isArray(v) ? v : [v])
          if (x !== undefined) url.searchParams.append(k, String(x));
      const label = ref === undefined ? op : `${op} ${ref}`;
      const send = async (token: string): Promise<Response> => {
        let res: Response;
        try {
          res = await fetch(url, {
            method: req.method ?? "GET",
            headers: {
              authorization: `Bearer ${token}`,
              ...(req.body !== undefined && { "content-type": "application/json" }),
            },
            ...(req.body !== undefined && { body: JSON.stringify(req.body) }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch {
          o.log(`[gmail] ${label} failed before an answer`);
          throw new GmailError(0, "Gmail could not be reached");
        }
        o.log(`[gmail] ${label} -> ${res.status}`);
        return res;
      };
      const token = await o.accessToken();
      let res = await send(token);
      if (res.status === 401) res = await send(await o.accessToken(token));
      if (!res.ok) throw await failure(res);
      return res.status === 204 ? undefined : res.json();
    },
  };
}
