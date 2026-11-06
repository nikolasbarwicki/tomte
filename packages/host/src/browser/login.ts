import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import type { CredentialEntry } from "@claudebot/contract/events";
import { z } from "zod";

import type { Credentials } from "../credentials/index.ts";
import type { HostOrigin } from "../platform/config.ts";
import { credentialSecretName, type SecretStore } from "../platform/secrets.ts";
import { EngineError, type PageData } from "./engine-cli.ts";
import type { HumanWaits, WaitingForUser } from "./human-waits.ts";
import type { PageState } from "./page-state.ts";
import type { BotBrowser } from "./runtime.ts";

export const CREDENTIAL_EXCHANGE_PATH = "/api/browser/credential-exchange";

/** The engine's name for the credential plugin; the action policy allows exactly `plugin:<name>:credential.read`. */
export const CREDENTIAL_PLUGIN_NAME = "claudebot";

export const NONCE_TTL_MS = 60_000;

interface Issued {
  botId: string;
  entryId: string;
  origin: string;
  expiresAt: number;
}

/** One-time login nonces, in memory only. A nonce is spent by its first redeem attempt, right or wrong. */
export class LoginNonces {
  private issued = new Map<string, Issued>();

  constructor(private now: () => number = Date.now) {}

  issue(botId: string, entry: Pick<CredentialEntry, "id" | "origin">): string {
    const nonce = randomBytes(32).toString("base64url");
    this.issued.set(nonce, {
      botId,
      entryId: entry.id,
      origin: entry.origin,
      expiresAt: this.now() + NONCE_TTL_MS,
    });
    return nonce;
  }

  revoke(nonce: string) {
    this.issued.delete(nonce);
  }

  /** The bot and entry a nonce was issued for, if it is unused, unexpired and `url` has the entry's scheme, host and port. */
  redeem(nonce: string, url: string): { botId: string; entryId: string } | undefined {
    const n = this.issued.get(nonce);
    this.issued.delete(nonce);
    if (!n || this.now() > n.expiresAt) return undefined;
    try {
      return new URL(url).origin === n.origin ? { botId: n.botId, entryId: n.entryId } : undefined;
    } catch {
      return undefined;
    }
  }
}

export type LoginResult =
  | WaitingForUser
  | { status: "signed_in"; site: string }
  | { status: "needs_another_step"; site: string }
  | { status: "failed"; reason: string };

export interface BrowserLoginDeps {
  credentials: Credentials;
  secrets: SecretStore;
  waits: HumanWaits;
  botName(botId: string): string;
  /** Where the credential plugin reaches the host, e.g. `http://127.0.0.1:PORT/api/browser/credential-exchange`. */
  exchangeUrl(): string;
  now?: () => number;
}

export interface BrowserLogin {
  /** Labels and sites of the entries a bot may ask to sign in with; nothing else about them. */
  list(): { label: string; site: string }[];
  /** Signs the bot's browser in with the entry called `label`, asking the user the first time. */
  login(botId: string, browser: BotBrowser, page: PageState, label: string): Promise<LoginResult>;
  /** The plugin's request: a username and password for a valid nonce, or nothing. */
  exchange(
    nonce: string,
    url: string,
  ): Promise<{ username: string; password: string; url: string } | undefined>;
  /** Serves `CREDENTIAL_EXCHANGE_PATH`. */
  handle(req: IncomingMessage, res: ServerResponse, host: HostOrigin): Promise<void>;
}

const PLUGIN_SCRIPT = fileURLToPath(new URL("./credential-plugin.ts", import.meta.url));

const FIELD = /^\s*- (?:textbox|searchbox|combobox|spinbutton)\s+"([^"]*)"/;
const CODE_FIELD = /code|otp|verif|token|passcode|authenticator|2fa|\bpin\b|one.?time/i;
const PASSWORD_FIELD = /pass/i;

/**
 * Decides what a sign-in left behind. The engine reports success as soon as it submitted the form, so the
 * page decides: a verification field means another step, a password field means the form came back, and no
 * input field at all means the user is in. After an engine error, any leftover field means a step the engine
 * could not complete (such as a username-only page).
 */
export function classifyAfterLogin(
  snapshot: string,
  engineFailed: boolean,
): "signed_in" | "needs_another_step" | "failed" {
  const names = snapshot.split("\n").flatMap((l) => FIELD.exec(l)?.[1] ?? []);
  if (names.some((n) => CODE_FIELD.test(n))) return "needs_another_step";
  if (names.some((n) => PASSWORD_FIELD.test(n))) return "failed";
  if (engineFailed) return names.length ? "needs_another_step" : "failed";
  return "signed_in";
}

export const NEEDS_STEP =
  "The sign-in needs one more step that the stored credential cannot complete (a verification code, another page or a passkey). Call browser_request_takeover with a one-sentence reason, then end your turn.";

export function createBrowserLogin(deps: BrowserLoginDeps): BrowserLogin {
  const nonces = new LoginNonces(deps.now);
  const asking = new Set<string>();

  function ask(botId: string, entry: CredentialEntry): WaitingForUser {
    const key = `${botId}\n${entry.id}`;
    const wait = deps.waits.request(botId, {
      kind: "approval",
      title: `Allow sign-in with "${entry.label}"?`,
      detail: `${deps.botName(botId)} wants to sign in to ${entry.origin} with the stored credential "${entry.label}". It never sees the password.`,
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
      onResolve: (outcome) => {
        asking.delete(key);
        if (outcome !== "allow") return;
        try {
          deps.credentials.grant(botId, entry.id);
        } catch {
          // The entry was deleted while the card was open.
        }
      },
      resume: (outcome) =>
        outcome === "allow"
          ? `The user allowed sign-in with "${entry.label}". Call browser_login("${entry.label}") again.`
          : `The user denied sign-in with "${entry.label}". Do not ask again; continue without it or report what is blocked.`,
    });
    asking.add(key);
    return wait;
  }

  async function signIn(
    botId: string,
    browser: BotBrowser,
    page: PageState,
    entry: CredentialEntry,
  ): Promise<LoginResult> {
    const nonce = nonces.issue(botId, entry);
    const plugins = JSON.stringify([
      {
        name: CREDENTIAL_PLUGIN_NAME,
        command: process.execPath,
        args: [PLUGIN_SCRIPT, deps.exchangeUrl()],
        capabilities: ["credential.read"],
      },
    ]);
    let loginError: string | undefined;
    try {
      // The engine follows redirects and fills wherever it lands, but with --no-navigate it refuses a page that does not match the entry's origin.
      await browser.call(["open", entry.signInUrl]);
      await browser.call(
        [
          "auth",
          "login",
          entry.id,
          "--credential-provider",
          CREDENTIAL_PLUGIN_NAME,
          "--item",
          nonce,
          "--no-navigate",
          "--url",
          entry.signInUrl,
        ],
        { env: { AGENT_BROWSER_PLUGINS: plugins } },
      );
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      loginError = e.message;
    } finally {
      nonces.revoke(nonce);
      page.invalidate();
    }
    let snapshot = "";
    try {
      snapshot = ((await browser.call(["snapshot", "-i"])) as PageData).snapshot ?? "";
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
    }
    const status = classifyAfterLogin(snapshot, loginError !== undefined);
    if (status === "failed")
      return { status, reason: loginError ?? "the site did not accept the stored credential" };
    return { status, site: entry.origin };
  }

  return {
    list: () => deps.credentials.list().map((e) => ({ label: e.label, site: e.origin })),

    async login(botId, browser, page, label) {
      const matches = deps.credentials
        .list()
        .filter((e) => e.label.toLowerCase() === label.trim().toLowerCase());
      if (matches.length === 0)
        return {
          status: "failed",
          reason: `no stored credential called "${label}"; call browser_credentials to see the available ones`,
        };
      if (matches.length > 1)
        return {
          status: "failed",
          reason: `several stored credentials are called "${label}"; ask the user to rename one`,
        };
      const [entry] = matches;
      if (!deps.credentials.hasGrant(botId, entry.id)) {
        if (asking.has(`${botId}\n${entry.id}`))
          return {
            status: "failed",
            reason: `the user has not answered the request to use "${entry.label}" yet; end your turn and wait for their answer`,
          };
        return ask(botId, entry);
      }
      return signIn(botId, browser, page, entry);
    },

    async exchange(nonce, url) {
      const hit = nonces.redeem(nonce, url);
      if (!hit || !deps.credentials.hasGrant(hit.botId, hit.entryId)) return undefined;
      const entry = deps.credentials.get(hit.entryId);
      const password = await deps.secrets.get(credentialSecretName(hit.entryId));
      return entry && password
        ? { username: entry.username, password, url: entry.signInUrl }
        : undefined;
    },

    async handle(req, res, host) {
      const deny = (status: number) =>
        void res
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "denied" }));
      if (req.method !== "POST") return deny(405);
      if (!host.namesHost(req.headers.host)) return deny(403);
      if (req.headers.origin !== undefined) return deny(403);
      let body: { nonce: string; url: string };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        body = z
          .object({ nonce: z.string(), url: z.string() })
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        return deny(400);
      }
      const credential = await this.exchange(body.nonce, body.url);
      if (!credential) return deny(403);
      res
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify(credential));
    },
  };
}
