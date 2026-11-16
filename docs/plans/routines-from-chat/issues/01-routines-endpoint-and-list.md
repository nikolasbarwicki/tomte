# 01: Routines endpoint and `list_routines`

**What to build:** Every bot session gets a `routines` MCP server on the agent listener, and the first tool on it is `list_routines`. This is the tracer bullet: a bot reads its own routines through a real endpoint, with a token, with its instructions in the prompt. See the spec sections "Where the tools live", "Tool schemas" and "Guards".

The endpoint copies `handoffs/endpoint.ts`:

- `routines/endpoint.ts` exports `createRoutinesEndpoint({ host, tokens, routines, unattended, now })`, `ROUTINES_ENDPOINT_PATH` (`/mcp/routines`), `ROUTINES_SERVER_NAME` (`routines`) and `ROUTINES_INSTRUCTIONS`. `handle` calls `serveMcpRequest` (`host-mcp/index.ts`) with a fresh `McpServer` per request. `lease(botId)` issues a token from the shared `TokenRegistry` and returns the server, the instructions and `release: revoke`.
- `routines/tools/context.ts` defines `RoutinesToolContext` (`botId` from the token, `routines`, `unattended(botId)`, `now()`). `routines/tools/result.ts` has `errorResult` and `jsonResult`. `routines/tools/list-routines.ts` exports `registerListRoutines(mcp, ctx)`; a shared `routineOut` maps a `Routine` to the spec's `RoutineOut` (ISO UTC times, snake_case, `next_runs` from `routines.preview`, no run output).
- `routines/index.ts` re-exports the endpoint pieces. `createRoutines` keeps its signature.
- `host-server/index.ts` builds the endpoint right after `createRoutines`, passes `chats.unattended`, adds its lease to `hostServers` (`combineLeases`) and exposes it as `HostServer.routines`. `host-server/http.ts` `agentRoutes` serves `ROUTINES_ENDPOINT_PATH` with the label `[routines] endpoint failed:`.
- `bots/thread.ts` `canUseTool` allows names starting with `mcp__routines__`, with the other host servers.
- `testing/test-host.ts`: `actAs(botId, server = "bots")` connects to the named server of the matching lease, so tests can use `actAs(botId, "routines")`.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `list_routines` returns `{ now, routines }` with the caller's own routines only, in creation order. A bot with none gets an empty list. A routine of another bot never appears
- [x] Each routine has `id`, `name`, `instruction`, `schedule` (cron as stored, once with `at` as ISO UTC), `active`, `catch_up`, `next_runs` (up to 3 ISO times, empty when paused or finished), `running` and `last_run` (`status`, `started_at`, `error`, no output)
- [x] The endpoint refuses a wrong Host, any Origin, a missing token and a revoked token, as the bots endpoint does. The client listener answers 404 for `/mcp/routines`
- [x] Every harness launch carries the `routines` server with its own token, and its instructions text is in the appended system prompt. The instructions say the owner's IANA time zone comes from user memory, then `ask_user` and `remember`, and never from the server
- [x] `mcp__routines__*` is allowed by `canUseTool` without an approval card (a unit test names `mcp__routines__list_routines`)
- [x] GLOSSARY gains **Routine tools** (the MCP tools exposed at the routines endpoint) and **Routines endpoint** (the host's Streamable HTTP MCP route that serves them, on the agent listener), next to the browser entries, and the **Agent listener** entry names the routines endpoint
- [x] Host HTTP-seam tests cover all of the above (prior art: `handoffs/handoffs.test.ts`, and `host-server/listeners.test.ts`, which asserts both endpoints on the agent listener and their 404 on the client listener). `bun run check` passes
