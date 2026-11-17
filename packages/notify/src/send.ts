import { ExternalEventPosted, type ExternalEventInput } from "@tomte/contract/api";
import { z } from "zod";

import type { Config } from "./config.ts";

export type Outcome = { ok: true; duplicate: boolean } | { ok: false; message: string };

const ErrorBody = z.object({ error: z.string() });

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** The JSON in a response body, or `undefined` for a body that is none (an HTML error page from a proxy, say). */
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Text from the other end made safe to print: no control characters, one line, bounded, the token masked. */
const printable = (text: string, token: string, max = 300) => {
  const line = text
    .split(token)
    .join("[redacted]")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/**
 * Posts one event with the token in the `Authorization` header and nowhere else. A redirect is not followed: it
 * would send the bearer somewhere the configuration did not name. Every failure is a message for stderr, with the
 * status and the server's own error text, and the token masked in case a server echoes it.
 */
export async function postEvent(
  { url, token }: Config,
  event: ExternalEventInput,
  timeoutMs: number,
): Promise<Outcome> {
  const { origin } = url;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (e) {
    const reason =
      e instanceof Error && e.name === "TimeoutError"
        ? `no answer within ${Math.round(timeoutMs / 1000)}s`
        : printable(e instanceof Error ? e.message : String(e), token);
    const sandbox = LOOPBACK.includes(url.hostname)
      ? " (a sandboxed shell cannot reach loopback, ADR-0007: run this outside the sandbox)"
      : "";
    return { ok: false, message: `could not reach ${origin}: ${reason}${sandbox}` };
  }

  const text = await res.text();
  if (res.status === 200 || res.status === 202) {
    const posted = ExternalEventPosted.safeParse(jsonOf(text));
    return posted.success
      ? { ok: true, duplicate: posted.data.duplicate }
      : {
          ok: false,
          message: `HTTP ${res.status} from ${origin}, but not an events route's answer`,
        };
  }
  const error = ErrorBody.safeParse(jsonOf(text));
  const said = printable(error.success ? error.data.error : text, token);
  const hint =
    res.status === 401
      ? " (the token or the bot in the URL is wrong; a rotated token stops working at once)"
      : "";
  return {
    ok: false,
    message: `HTTP ${res.status} from ${origin}${said === "" ? "" : `: ${said}`}${hint}`,
  };
}
