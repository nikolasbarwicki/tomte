# 0005: Separate agent and client listeners, with device tokens for people

Status: accepted

## Context

The host served bots and people on one loopback port and trusted every request that reached it. The browser endpoint checked a bot's bearer token (ADR-0001), but the UI API checked no Host, no Origin and no token. Any web page the user opened could call it. A cross-origin `text/plain` POST created a bot, and a page that rebound its hostname to `127.0.0.1` read the event stream. Only the browser UI routes behind `guardUiRequest` were protected.

Bots and people are different callers. A bot is untrusted: a prompt-injected page or bot must be held to a per-session bearer token and nothing else. A person is trusted once the host has recognised their device, and that device is a browser, a script, or the desktop app. Mixing them on one socket meant one rule set had to serve both, and the looser one won.

## Decision

### Two listeners

The host opens two sockets.

- **Agent listener.** It binds `127.0.0.1` on a free port. It serves the browser endpoint, the bots endpoint, the routines endpoint and the credential exchange, and nothing else. Its checks are the ones in ADR-0001: Host names this listener, the request carries no `Origin`, and every request has the per-session bearer token. The MCP config written for each harness points at this listener. Any other path answers 404.
- **Client listener.** It binds the address and port from `HostConfig`. It serves the web UI, `/api/*` (including the event stream, live view, takeover input and wait answers), `/oauth/callback` and the pairing route `/api/pair`. It never serves the agent listener's routes and answers 404 for them.

An agent and a person never share a listener. A request cannot reach the other side's routes by choosing a different path or header, because the routes are not registered on that socket. Neither side's rules can be weakened to make the other work.

### Boundary check

`withBoundary` in `packages/host/src/host-server/boundary.ts` wraps the client listener. Every request passes it before routing, so a request that fails never reaches a handler. The checks run in this order:

1. **Host.** The `Host` header must be the listener's loopback address (`127.0.0.1:<port>` or `localhost:<port>`) or the public URL's host. Otherwise the response is 403 `bad host`. This stops DNS rebinding.
2. **Origin, mutating methods only.** For any method other than `GET`, `HEAD` and `OPTIONS`, `Origin` must be the public URL's origin or the loopback origin. A missing or other `Origin` gets 403. This stops other web pages.
3. **Content type, mutating methods only.** The `Content-Type` must be `application/json`, with or without parameters. Otherwise the response is 415. A browser must send a CORS preflight to set this type cross-origin, so a plain form or `text/plain` POST fails.
4. **Device token.** The request must present a valid device token. Otherwise the response is 401 `pair this device first`.

These paths skip the device token check only, except where an entry below says more. Host, Origin and content type still apply to them.

- `POST /api/pair`, the pairing exchange.
- `GET /api/host-info`, which says what this host is and can do so the UI can hide actions it cannot perform. It returns the host version, the API version, the mode, the Claude sign-in state in remote mode only, and the reveal, headed-browser and browser-sandbox capabilities, and nothing else: no bot, path, device or secret. The Claude sign-in state is the one piece of host state a request without a token can read, a deliberate exception. Any other method on this path needs a device token. It is never served on the agent listener.
- `/oauth/callback`, which its OAuth `state` parameter protects.
- Every path outside `/api/*`: the static UI assets and the login page, which must load before a device has a token.
- `POST /api/bots/<botId>/events`, which skips the Origin check as well, and is protected by the bot's event token instead. See [ADR 0007](0007-external-events-route-and-event-token.md).

The boundary check replaces `guardUiRequest`. The body-reading half of that guard remains as `readUiBody` in `packages/host/src/browser/ui-request.ts`.

### Device token

A device token is 32 random bytes, encoded as base64url. The host stores only its SHA-256 digest in the `devices` table and compares digests in constant time against every row, as `TokenRegistry` does for bot sessions. The token is visible once, in the pairing response. A device has an id, a name, a creation time and a last-seen time. An authenticated request moves the last-seen time forward at most once a minute, so a busy page does not write the database on every request.

A client presents the same token in either form:

- **Bearer.** `Authorization: Bearer <token>`. Scripts use this, and so does the desktop app's main process for the calls it makes itself (the revoke of a connection profile's device, below). The app's window uses the cookie.
- **Cookie.** `tomte_session=<token>`. The browser sends it on every request, including the `EventSource` for the event stream, which cannot set headers. The bearer header wins when both are present.

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

### Sidecar topology

The desktop app (`packages/desktop/`, an Electron shell) does not embed the host. It starts the host binary as a child process, `--sidecar`, loads the UI that host serves and signs the window in to it.

- **No host code in the shell.** The dependency rule `desktop-only-to-contract` (ADR-0003) fails the build when `packages/desktop/` imports any workspace package but the contract, and `host-not-to-desktop` stops the host importing the shell. The shell neither runs host code in its own process nor bundles the web UI. It reads the contract's `sidecar` schemas and nothing else of the host.
- **UI from the host.** The window loads the host's client listener URL, so the UI, the `/api/*` it calls and the contract come from one build. The renderer has context isolation and the sandbox on, no Node and no preload script. The host serves the UI over the same listener and the same boundary check as it does to a browser; the shell adds no route.
- **Start and stdin protocol.** `--sidecar` is local mode only; with `--mode remote` it is a configuration error. The shell spawns the host with piped stdio and writes one line to its stdin: a launch token, 32 random bytes as base64url, 43 characters (`LaunchToken` in `@tomte/contract/sidecar`). It keeps the pipe open for the host's whole life.
  - The host reads the first line (at most 1024 bytes; a longer line without a newline is cut there) and parses it as a `LaunchToken`. If stdin ends first, or the line is not a launch token, the host exits with code 2 without echoing the line. Later input is read and dropped, so the host sees the pipe close.
  - When stdin ends, the host runs the same graceful stop as for SIGINT and SIGTERM: it closes every bot's thread and Claude CLI child, the browser engine and Chrome, stops both listeners and releases the data-root lock, then exits 0. The shell's quit path ends the pipe and waits for that, killing the host after 30 seconds. If the app dies, the operating system closes the pipe and the host stops by itself.
  - Without `--sidecar` the host never reads stdin.
  - A sidecar installs the managed Claude CLI into the data root when none resolves, because a first launch from an app has no terminal to run `install-cli` in. Its human-readable output goes to stderr, which the shell appends to `host.log` in its own user-data folder.
- **Launch device.** After the listeners are up, the host registers the launch token as a device named "This computer" (`LAUNCH_DEVICE_NAME`), in one write transaction that first deletes the device an earlier launch registered. The earlier one is found by the `launch` column on `devices`, a unique partial index allows one such row, and the name is never consulted, so a device a person paired under the same name stays. A restarted host therefore has a new launch device and the old token stops working. The token needs no pairing code: the shell holds a stdin pipe to a process it started, which is the proof of identity a code would otherwise supply.
- **Ready line.** Once the launch device is registered, the host writes one JSON line to stdout, `{"type":"ready","clientUrl":"http://127.0.0.1:<port>"}` (`SidecarReady`), and nothing else goes to stdout. The shell waits up to 180 seconds for it (the first launch downloads the CLI). A first line that is not a `SidecarReady`, an exit before it, or the timeout fails the start, and the shell shows the end of the host log.
- **Session cookie, no token in a URL.** The shell sets `tomte_session=<launch token>` itself, in the window's own session for the client listener's origin (`HttpOnly`, `SameSite=Strict`, `Secure` for `https:`, no expiry), and then loads the plain client URL. The token never appears in a URL, a log line or the ready line: the ready line carries the URL only.
- **Navigation.** Navigation (`will-navigate`, `will-redirect`) is limited to the active host's origin. Any other `http:` or `https:` URL is refused in the window and handed to the system browser with `shell.openExternal`; other schemes are denied. `window.open` never opens a window: a same-origin target is denied, any other web URL goes to the system browser. Pages get one permission, writing to the clipboard. Electron's default certificate checks apply to the window; nothing in the shell handles `certificate-error`.

### Connection profiles

The shell can show a second host, such as a remote-mode server, through a connection profile: a name, an origin, the device id and the device token the host issued to this app. The built-in profile `local` is the sidecar, comes from the supervisor's current sidecar at every use and is never stored.

- **Pairing.** Adding a profile takes the host's origin and a pairing code made on that host. The shell first reads `GET /api/host-info` and compares its `apiVersion` with the versions it supports (`SUPPORTED_API`, now exactly the contract's `API_VERSION`); a mismatch is refused with a message saying which side to update, and the check runs again at every connect. It then posts `/api/pair`, takes the device id and token from the response body, and drops the `Set-Cookie`: the request is sent without cookies.
- **Origin of main-process requests.** The origin is a bare origin: `https:`, or `http:` for a loopback host only (a tunnel to a remote); a plain-HTTP private network is refused, since the token and the session would cross it unencrypted. The main process sends `Origin: <that origin>` and `Content-Type: application/json` on the mutating calls it makes (`/api/pair`, `/api/devices/revoke`), so the boundary check's Origin rule stays as it is and no exemption exists for the shell. It also sends no cookies and never follows a redirect, so a token reaches only the origin it was issued for. Requests go through Electron's `net.fetch`, so Chromium's certificate checks decide whether a connection is made. A page in the window makes its own requests, which carry the host's origin as in any browser.
- **Storage.** The token is encrypted with Electron's `safeStorage` and written to `profiles.json` in the app's own user-data folder (file mode 0600), with the id and name. The shell refuses to add a profile when `safeStorage` is unavailable or, on Linux, when it would keep the key in a plaintext file (`basic_text`); a token is never stored in the clear. If the profile cannot be saved after pairing, the shell revokes the device it just created.
- **Connect.** Connecting version-checks the host, sets the session cookie for its origin in the window's session and loads it. The chosen profile is the one opened at the next start; if it cannot be reached then, the window shows "This computer" and the saved choice stays.
- **Forget.** Forgetting a profile revokes the app's device on that host with the profile's own token (`/api/devices/revoke`; a 401 means the host already revoked it), then deletes the stored token and clears what the window's session stored for the origin. If the host cannot be reached the shell reports it and forgets the profile only when the user asks to do so without revoking, which leaves the device on the host for the user to revoke from its Devices page.
- **Connections window.** The profile list and its forms are served by the shell itself from a privileged `tomte-desktop:` scheme in an in-memory session partition, with the same sandbox settings, no preload, and navigation pinned to that scheme. It cannot reach a host and no host page can reach it.

## Alternatives considered

- **One listener with per-route rules.** Keep a single port and add the boundary check to the UI routes only. Rejected: the first mistaken route registration puts a bot-facing route behind the loose rule set, or a UI route behind the bot's. Two sockets make that mistake impossible.
- **Fix the UI API with the browser endpoint's checks.** Require a bearer token on `/api/*`. Rejected: the UI uses `EventSource`, which cannot set headers, and a token kept in page script is readable by that script. A cookie that is `HttpOnly` and `SameSite=Strict` fixes both.
- **A first-run setup page.** Let the first browser to connect claim the host. Rejected: it is an unauthenticated route that anyone who reaches the port first can use. `host pair` needs shell access to the machine instead.
- **A shared password.** Rejected: it cannot be revoked per device, and a stolen one gives lasting access.
- **Long-lived pairing codes.** Rejected: a code a person photographed or pasted into chat would stay valid. Ten minutes and single use bound the damage.
- **Run the host inside the desktop app's main process.** Rejected: the shell would import host code and the UI would be built apart from it, so UI, API and contract could come from different builds. A child process behind `desktop-only-to-contract` keeps one build and one set of rules, and its stdin pipe ties its life to the app's.
- **Put the launch token in the window's URL.** Rejected: a URL ends up in history, logs and the `Referer`. The shell sets the cookie in its own session instead.

## Consequences

- Every browser must pair before it can use the host. A script or the desktop app's main process uses the same token as a bearer.
- Bot tool calls are unaffected: the agent listener keeps the rules of ADR-0001, and the existing handoff tests pass through it unchanged.
- The boundary check is part of the trust boundary, like the checks in ADR-0001. A route added under `/api/*` gets device-token protection with no extra code. A route added outside `/api/*` is public, so it must not carry host state.
- A device token is a bearer credential. Anyone who obtains it acts as that device until the user revokes it.
- The client listener binds loopback unless configured otherwise; see the note below.
- The desktop app adds no route and no rule to the boundary check. The host registers one more kind of device through the launch token (see "Sidecar topology"), and the shell's calls to a host pass the same checks as a script's.

### Decisions kept on purpose

- **Origin is required on every mutating request, bearer clients included.** The boundary check does not exempt a request because it carries `Authorization: Bearer`. One rule for every caller keeps the check simple and leaves no path where a missing `Origin` is trusted. Scripts send the host's origin, and so does the desktop main process on its mutating calls (see "Connection profiles"); the desktop app did not need the rule revisited. The one exception is the events route, which has no device token to protect; see [ADR 0007](0007-external-events-route-and-event-token.md).
- **A wrong content type gets 415, not 403.** Host and Origin failures are 403 because they identify a caller the host refuses. A wrong content type is a malformed request from a caller that may be allowed, so it gets the status that names the problem. A cross-origin `text/plain` POST still gets 403, because the Origin check runs first.
- **One global pairing lockout counter, reset when a code is created.** The host counts failed exchanges in one database row, not per address, so `host pair` in another process and a restarted host see the same count. Creating a code, from `host pair` or the Devices page, resets the count, and so does the lockout itself. A successful exchange does not. Each code therefore gets at most 10 guesses, and old typos cannot lock out a fresh code. The cost is that anyone who reaches the client listener can lock out the current code with 10 bad requests, and the user creates a new one. Locked-out attempts get the same 401 as a wrong code.
- **Revoke ends every open response for the device, not only event streams.** Live view and takeover streams stay open as long as an event stream does, and in-flight requests started before the revoke would otherwise finish with the revoked device's access. Ending all of them makes revocation take effect at once.

## Note: binding the client listener beyond loopback

`HostConfig.bind` may now name a non-loopback address, in either mode. Parsing accepts it only when the public URL is `https:` or `--allow-plain-http` (`TOMTE_ALLOW_PLAIN_HTTP`) is set for a private network such as Tailscale; an unset public URL counts as plain HTTP. The error names both ways out. The agent listener still binds `127.0.0.1` only, and the device-token checks above apply on any address.
