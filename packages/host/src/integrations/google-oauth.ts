import { createHash, randomBytes } from "node:crypto";

import { OAuthTokensSchema, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/** Where the host reaches Google: sign-in, tokens and the Gmail API. Tests and smokes point these at a loopback fake. */
export interface GoogleEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  gmailApiBase: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  gmailApiBase: "https://gmail.googleapis.com/gmail/v1",
};

const TOKEN_TIMEOUT_MS = 20_000;

/** A PKCE pair: the verifier is kept for the token request, the challenge goes in the authorization URL. */
export function newPkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The authorization-code request with PKCE. Offline access and a fresh consent make Google issue a refresh token. */
export function authorizationUrl(
  endpoints: GoogleEndpoints,
  o: { clientId: string; redirectUrl: string; scope: string; state: string; challenge: string },
): URL {
  const u = new URL(endpoints.authorizationUrl);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUrl,
    scope: o.scope,
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return u;
}

/** Trades the authorization code for tokens. A refusal carries Google's error code only, never the request. */
export async function exchangeCode(
  endpoints: GoogleEndpoints,
  o: {
    client: { client_id: string; client_secret?: string | undefined };
    code: string;
    verifier: string;
    redirectUrl: string;
  },
): Promise<OAuthTokens> {
  const res = await fetch(endpoints.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: o.code,
      code_verifier: o.verifier,
      redirect_uri: o.redirectUrl,
      client_id: o.client.client_id,
      ...(o.client.client_secret !== undefined && { client_secret: o.client.client_secret }),
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const code = (body as { error?: unknown } | undefined)?.error;
    throw new Error(`Google refused the sign-in${typeof code === "string" ? ` (${code})` : ""}`);
  }
  const tokens = OAuthTokensSchema.safeParse(body);
  if (!tokens.success) throw new Error("Google's answer carried no access token");
  return tokens.data;
}

/** Google no longer honours the stored grant (`invalid_grant`): it was revoked, expired or replaced. Only a new sign-in helps. */
export class GrantRevoked extends Error {}

/**
 * Trades a refresh token for a new access token. Google usually leaves the refresh token out of the answer, so the caller keeps the
 * one it has. `invalid_grant` is `GrantRevoked`; any other failure is a plain Error that carries Google's error code only, never the request.
 */
export async function refreshTokens(
  endpoints: GoogleEndpoints,
  o: { client: { client_id: string; client_secret?: string | undefined }; refreshToken: string },
): Promise<OAuthTokens> {
  let res: Response;
  try {
    res = await fetch(endpoints.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: o.refreshToken,
        client_id: o.client.client_id,
        ...(o.client.client_secret !== undefined && { client_secret: o.client.client_secret }),
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Google could not be reached to refresh the Gmail sign-in");
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const code = (body as { error?: unknown } | undefined)?.error;
    if (code === "invalid_grant")
      throw new GrantRevoked("Google no longer accepts the Gmail sign-in (invalid_grant)");
    throw new Error(
      `Google refused to refresh the Gmail sign-in${typeof code === "string" ? ` (${code})` : ""}`,
    );
  }
  const tokens = OAuthTokensSchema.safeParse(body);
  if (!tokens.success) throw new Error("Google's answer carried no access token");
  return tokens.data;
}
