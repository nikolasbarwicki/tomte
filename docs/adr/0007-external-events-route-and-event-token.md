# 0007: External events post to the client listener with a per-bot event token

Status: accepted. Amends [ADR-0005](0005-agent-and-client-listeners-and-device-auth.md): one route on the client listener is exempt from the device token and the Origin check.

## Context

A bot can start work that outlives its turn: a script, a coordinator that runs several coding agents, a CI poller. The host should hear from that work, show it to the user and wake the bot when it needs an answer. The sender is an ordinary process, usually a shell command the bot started, so it needs a URL and a credential it can read from its environment.

Neither listener fits as ADR-0005 left it.

- The agent listener binds a free port that changes on every start, and its credentials are per-session MCP tokens for a harness's tool calls. A script that outlives a session, or a restart, would hold a dead URL and a dead token.
- The client listener has a port from `HostConfig` that is stable across restarts, but every route there wants a device token and an `Origin`. A device token is the user's own credential, so handing it to a bot's script would give that script the whole UI API: other bots, integrations, device management.

## Decision

`POST /api/bots/<botId>/events` is a route on the client listener. It is checked by its own credential, the bot's **event token**, and by nothing else.

- **Event token.** 32 random bytes, base64url, one per bot. It authorizes posting events to that bot and nothing more: on any other `/api/*` route it fails the device token check like any wrong token. The host stores it in the secrets backend (`events-token:<botId>`, the OS keychain or the encrypted file), not as a digest, because it must put the plaintext in the environment of the bot's Claude CLI as `TOMTE_EVENTS_TOKEN`, next to `TOMTE_EVENTS_URL`. It is made the first time something asks for it. Rotating it from the UI (`/api/bots/events-token/rotate`) invalidates the old one at once; sessions already running keep the old value in their environment until their next session. Deleting the bot deletes it. It never appears in the event stream or in a URL; the UI reads it through the device-authenticated `/api/bots/events-token`.
- **Boundary.** The route is exempt from the device token check and from the Origin rule. Host and content type still apply: a request whose `Host` is not this host's gets 403 and a body that is not `application/json` gets 415. The exemption is for `POST` on this one path shape; any other method on it takes the normal path through the boundary. The route accepts only `Authorization: Bearer`, never the session cookie, so a browser that holds a device cookie cannot be made to post.
- **Why no Origin.** The callers are scripts, which do not send one. The rule exists to stop other web pages. A page cannot post here: the request needs a bearer header and a JSON content type, which forces a preflight the host does not answer, and it needs a token the page never sees.
- **One answer for every failed check.** A missing token, a wrong one, another bot's and an unknown bot all get the same 401 with the same body, before the body is read, so the route does not tell a caller which bot ids exist. Tokens are compared by SHA-256 digest with `timingSafeEqual`.
- **Limits.** The body is read up to 64 KiB (413 beyond that); the schema bounds every field (400 naming the first path that fails).
- **Untrusted text.** An event's text comes from outside the host. The bot receives it wrapped in markers that carry a random nonce, with invisible characters removed and a line saying it is data, as page text from the browser tools is (`wrapExternalEvent`, `shapePage`). A bot still acts with its normal permissions on what it reads, so the wrapping is a mitigation.

## Consequences

- The events URL is `<client listener's loopback URL>/api/bots/<botId>/events`, stable while `HostConfig` is. It is the host's bind address, so a host that binds a wildcard address gives its bots a URL that may not be a good loopback address.
- **The caller is not verified to be local.** In remote mode the client listener is on the network behind the public URL, so anyone holding a bot's token can post to it from anywhere. The token is the whole credential. A leaked token lets someone put text in front of that bot (wrapped as untrusted) and nothing else; rotating it ends that.
- **A sandboxed shell cannot reach the route.** The shell sandbox gives a bot's commands no loopback access. A coordinator started from a sandboxed Bash cannot post here. The environment variables are present regardless, so a process started outside the sandbox can.
- A crash after an event is stored and before it is delivered to the bot loses the wake-up. The event is stored and a retry with the same key answers 200 `duplicate` without delivering again.
- If the token cannot be read when a session starts (a locked keychain), the session starts without the two variables and the host logs why; the bot still works.
