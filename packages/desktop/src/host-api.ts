import { API_VERSION, PairingResponse, PublicHostInfo } from "@tomte/contract/api";
import { z } from "zod";

import { ConnectionError } from "./connection-error.ts";

/** The host's error body, such as `{ "error": "invalid pairing code" }`. */
const ErrorBody = z.object({ error: z.string().min(1) });

/** The API versions this app speaks. One constant, so widening support is a one-line change. */
const SUPPORTED_API: { min: number; max: number } = { min: API_VERSION, max: API_VERSION };

const REQUEST_TIMEOUT_MS = 10_000;

/** The shape of `fetch` the client needs: the app passes Electron's `net.fetch`, so Chromium's network stack and certificate checks decide every connection. */
export type HostFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HostClient {
  /** `GET /api/host-info`, then the version check; throws a `ConnectionError` naming the way out on a mismatch. */
  checkHost(origin: string): Promise<PublicHostInfo>;
  /** Exchanges a pairing code for a device; a wrong code throws with the host's own error text. */
  pair(origin: string, code: string, deviceName: string): Promise<PairingResponse>;
  /** Revokes `deviceId` with its own token. 401 means the host already revoked it, which is the same outcome. */
  revoke(origin: string, token: string, deviceId: string): Promise<"revoked" | "already-revoked">;
}

/** Throws when `apiVersion` is outside `SUPPORTED_API`, saying which side to update. Nothing else happens on a mismatch. */
function checkApiVersion(origin: string, apiVersion: number): void {
  const { min, max } = SUPPORTED_API;
  if (apiVersion >= min && apiVersion <= max) return;
  const needs = min === max ? String(min) : `${min} to ${max}`;
  const verdict = apiVersion < min ? "Update the host." : "Update the desktop app.";
  throw new ConnectionError(
    `The host at ${origin} runs API version ${apiVersion}; this app needs ${needs}. ${verdict}`,
  );
}

function describeNetworkError(origin: string, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return `The host at ${origin} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`;
  const code = /net::ERR_[A-Z0-9_]+/.exec(text)?.[0];
  if (code !== undefined && /ERR_CERT|ERR_SSL|ERR_BAD_SSL/.test(code))
    return `The host at ${origin} did not present a valid certificate (${code}); the connection was refused.`;
  return `Could not reach the host at ${origin}: ${code ?? text}`;
}

async function errorText(response: Response): Promise<string> {
  const body = ErrorBody.safeParse(await response.json().catch(() => undefined));
  return body.success ? body.data.error : `HTTP ${response.status}`;
}

/** Talks to a host's client listener from the app's main process. Requests carry no cookies and never follow a redirect, so a token only ever goes to the origin it was issued for. */
export function createHostClient(fetchHost: HostFetch): HostClient {
  async function send(
    origin: string,
    path: string,
    options: { token?: string; body?: object } = {},
  ): Promise<Response> {
    const mutating = options.body !== undefined;
    const headers: Record<string, string> = {};
    // ADR 0005 keeps Origin required on every mutating request, bearer clients included.
    if (mutating) {
      headers.origin = origin;
      headers["content-type"] = "application/json";
    }
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    try {
      return await fetchHost(`${origin}${path}`, {
        method: mutating ? "POST" : "GET",
        headers,
        body: mutating ? JSON.stringify(options.body) : undefined,
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ConnectionError(describeNetworkError(origin, error));
    }
  }

  return {
    async checkHost(origin) {
      const response = await send(origin, "/api/host-info");
      const notTomte = `The server at ${origin} is not a Tomte host (HTTP ${response.status}).`;
      if (!response.ok) throw new ConnectionError(notTomte);
      const info = PublicHostInfo.safeParse(await response.json().catch(() => undefined));
      if (!info.success) throw new ConnectionError(notTomte);
      checkApiVersion(origin, info.data.apiVersion);
      return info.data;
    },

    async pair(origin, code, deviceName) {
      const response = await send(origin, "/api/pair", { body: { code, name: deviceName } });
      if (!response.ok)
        throw new ConnectionError(`The host refused the pairing: ${await errorText(response)}`);
      const paired = PairingResponse.safeParse(await response.json().catch(() => undefined));
      if (!paired.success)
        throw new ConnectionError(`The host at ${origin} answered the pairing in an unknown form.`);
      return paired.data;
    },

    async revoke(origin, token, deviceId) {
      const response = await send(origin, "/api/devices/revoke", {
        token,
        body: { id: deviceId },
      });
      if (response.ok) return "revoked";
      if (response.status === 401) return "already-revoked";
      throw new ConnectionError(`The host refused the revoke: ${await errorText(response)}`);
    },
  };
}
