import { SESSION_COOKIE } from "@claudebot/contract/sidecar";

/** A browser stays paired for as long as browsers let a cookie live. */
const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** The `Set-Cookie` value that signs a browser in. The token is base64url, so it needs no escaping. */
export function sessionCookie(token: string, publicUrl: string): string {
  const secure = new URL(publicUrl).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

/** The session cookie's value in a `Cookie` header, if there is one. */
export function readSessionCookie(header: string | undefined): string | undefined {
  for (const pair of header?.split(";") ?? []) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq).trim() === SESSION_COOKIE) return pair.slice(eq + 1).trim();
  }
  return undefined;
}
