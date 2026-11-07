# 0005: Separate agent and client listeners, with device tokens for people

Status: accepted

## Context

The host served bots and people on one loopback port and trusted every request that reached it. The browser endpoint checked a bot's bearer token (ADR-0001), but the UI API checked no Host, no Origin and no token. Any web page the user opened could call it. A cross-origin `text/plain` POST created a bot, and a page that rebound its hostname to `127.0.0.1` read the event stream. Only the browser UI routes behind `guardUiRequest` were protected.

Bots and people are different callers. A bot is untrusted: a prompt-injected page or bot must be held to a per-session bearer token and nothing else. A person is trusted once the host has recognised their device, and that device is a browser, a script, or later the desktop app. Mixing them on one socket meant one rule set had to serve both, and the looser one won.

## Decision

### Two listeners

The host opens two sockets.

- **Agent listener.** It binds `127.0.0.1` on a free port. It serves the browser endpoint, the bots endpoint and the credential exchange, and nothing else. Its checks are the ones in ADR-0001: Host names this listener, the request carries no `Origin`, and every request has the per-session bearer token. The MCP config written for each harness points at this listener. Any other path answers 404.
- **Client listener.** It binds the address and port from `HostConfig`. It serves the web UI, `/api/*` (including the event stream, live view, takeover input and wait answers), `/oauth/callback` and the pairing route `/api/pair`. It never serves the agent listener's routes and answers 404 for them.

An agent and a person never share a listener. A request cannot reach the other side's routes by choosing a different path or header, because the routes are not registered on that socket. Neither side's rules can be weakened to make the other work.

### Boundary check

`withBoundary` in `packages/host/src/host-server/boundary.ts` wraps the client listener. Every request passes it before routing, so a request that fails never reaches a handler. The checks run in this order:

1. **Host.** The `Host` header must be the listener's loopback address (`127.0.0.1:<port>` or `localhost:<port>`) or the public URL's host. Otherwise the response is 403 `bad host`. This stops DNS rebinding.
2. **Origin, mutating methods only.** For any method other than `GET`, `HEAD` and `OPTIONS`, `Origin` must be the public URL's origin or the loopback origin. A missing or other `Origin` gets 403. This stops other web pages.
3. **Content type, mutating methods only.** The `Content-Type` must be `application/json`, with or without parameters. Otherwise the response is 415. A browser must send a CORS preflight to set this type cross-origin, so a plain form or `text/plain` POST fails.
4. **Device token.** The request must present a valid device token. Otherwise the response is 401 `pair this device first`.

These paths skip the device token check only. Host, Origin and content type still apply to them.

- `POST /api/pair`, the pairing exchange.
- `GET /api/host-info`, which says what this host is and can do so the UI can hide actions it cannot perform. It returns the host version, the API version, the mode, the Claude sign-in state in remote mode only, and the reveal, headed-browser and browser-sandbox capabilities, and nothing else: no bot, path, device or secret. The Claude sign-in state is the one piece of host state a request without a token can read, a deliberate exception. Any other method on this path needs a device token. It is never served on the agent listener.
- `/oauth/callback`, which its OAuth `state` parameter protects.
- Every path outside `/api/*`: the static UI assets and the login page, which must load before a device has a token.

The boundary check replaces `guardUiRequest`. The body-reading half of that guard remains as `readUiBody` in `packages/host/src/browser/ui-request.ts`.

### Device token

A device token is 32 random bytes, encoded as base64url. The host stores only its SHA-256 digest in the `devices` table and compares digests in constant time against every row, as `TokenRegistry` does for bot sessions. The token is visible once, in the pairing response. A device has an id, a name, a creation time and a last-seen time. An authenticated request moves the last-seen time forward at most once a minute, so a busy page does not write the database on every request.

A client presents the same token in either form:

- **Bearer.** `Authorization: Bearer <token>`. Scripts use this, and the desktop app's main process will.
- **Cookie.** `claudebot_session=<token>`. The browser sends it on every request, including the `EventSource` for the event stream, which cannot set headers. The bearer header wins when both are present.

The cookie is `HttpOnly`, `SameSite=Strict` and `Path=/`, and it is `Secure` whenever the public URL is HTTPS. Its `Max-Age` is 400 days, the longest lifetime Chrome allows, so a browser stays paired until the user revokes it. `HttpOnly` keeps scripts in the page from reading the token. `SameSite=Strict` keeps other sites from sending it.

### Pairing code

A device gets its token by exchanging a pairing code. The user creates the code with the `host pair` subcommand or from the Devices page of an already-paired device.

- A code is 12 base32 characters (`A-Z` and `2-7`), shown in groups of four, such as `ABCD-EFGH-IJKL`. The host stores only its SHA-256 digest in the `pairing_codes` table. When a person types a code back, case, hyphens and spaces are ignored.
- A code is single-use. The host marks it used when a device pairs with it.
- A code expires 10 minutes after creation.
- After 10 failed attempts, the host invalidates every outstanding pairing code. The user must create a new one.

`POST /api/pair` takes `{ code, name }` and returns the device token in the body. It also sets the session cookie, so a browser and a script use the same route. A malformed body gets 400. A wrong code gets 401 `invalid pairing code`, with no hint about why.

`host pair` writes to the database only, so it runs next to a running host and needs no unauthenticated setup page. `pairing_codes` and `devices` belong to the device-auth feature, behind its own interface, as ADR-0003 requires.

### Device routes

Three routes under `/api/devices/` sit behind the boundary check like every other `/api/*` route. `list` returns each device's id, name, creation time and last-seen time, and marks the one that made the request. `pairing-code` creates a pairing code for the Devices page. `revoke` deletes a device, so its next request gets 401, and then ends every response still open for it, including its event stream and live view, so a revoked device stops receiving at once rather than when its page closes. The host answers a revoke before it closes the device's responses, so a device that revokes itself still gets its answer. The host tracks open responses by device id, in memory.

## Alternatives considered

- **One listener with per-route rules.** Keep a single port and add the boundary check to the UI routes only. Rejected: the first mistaken route registration puts a bot-facing route behind the loose rule set, or a UI route behind the bot's. Two sockets make that mistake impossible.
- **Fix the UI API with the browser endpoint's checks.** Require a bearer token on `/api/*`. Rejected: the UI uses `EventSource`, which cannot set headers, and a token kept in page script is readable by that script. A cookie that is `HttpOnly` and `SameSite=Strict` fixes both.
- **A first-run setup page.** Let the first browser to connect claim the host. Rejected: it is an unauthenticated route that anyone who reaches the port first can use. `host pair` needs shell access to the machine instead.
- **A shared password.** Rejected: it cannot be revoked per device, and a stolen one gives lasting access.
- **Long-lived pairing codes.** Rejected: a code a person photographed or pasted into chat would stay valid. Ten minutes and single use bound the damage.

## Consequences

- Every browser must pair before it can use the host. A script or a future desktop app uses the same token as a bearer.
- Bot tool calls are unaffected: the agent listener keeps the rules of ADR-0001, and the existing handoff tests pass through it unchanged.
- The boundary check is part of the trust boundary, like the checks in ADR-0001. A route added under `/api/*` gets device-token protection with no extra code. A route added outside `/api/*` is public, so it must not carry host state.
- A device token is a bearer credential. Anyone who obtains it acts as that device until the user revokes it.
- The client listener binds loopback unless configured otherwise; see the note below.
- The desktop app spec will add the sidecar topology to this ADR: how the desktop main process starts the host and obtains its first device token.

### Decisions kept on purpose

- **Origin is required on every mutating request, bearer clients included.** The boundary check does not exempt a request because it carries `Authorization: Bearer`. One rule for every caller keeps the check simple and leaves no path where a missing `Origin` is trusted. Scripts send the host's origin. The desktop app spec may revisit this for the desktop main process.
- **A wrong content type gets 415, not 403.** Host and Origin failures are 403 because they identify a caller the host refuses. A wrong content type is a malformed request from a caller that may be allowed, so it gets the status that names the problem. A cross-origin `text/plain` POST still gets 403, because the Origin check runs first.
- **One global pairing lockout counter, reset when a code is created.** The host counts failed exchanges in one database row, not per address, so `host pair` in another process and a restarted host see the same count. Creating a code, from `host pair` or the Devices page, resets the count, and so does the lockout itself. A successful exchange does not. Each code therefore gets at most 10 guesses, and old typos cannot lock out a fresh code. The cost is that anyone who reaches the client listener can lock out the current code with 10 bad requests, and the user creates a new one. Locked-out attempts get the same 401 as a wrong code.
- **Revoke ends every open response for the device, not only event streams.** Live view and takeover streams stay open as long as an event stream does, and in-flight requests started before the revoke would otherwise finish with the revoked device's access. Ending all of them makes revocation take effect at once.

## Note: binding the client listener beyond loopback

`HostConfig.bind` may now name a non-loopback address, in either mode. Parsing accepts it only when the public URL is `https:` or `--allow-plain-http` (`CLAUDEBOT_ALLOW_PLAIN_HTTP`) is set for a private network such as Tailscale; an unset public URL counts as plain HTTP. The error names both ways out. The agent listener still binds `127.0.0.1` only, and the device-token checks above apply on any address.
