# 0003: Feature modules with enforced dependency rules

Status: accepted

## Context

The backend grew as a flat `src/` folder plus a 955-line `host-server.ts` that wired about 31 modules, routed HTTP and served every `/api/*` handler, with the same error-handling block repeated five times. Shared types lived in the UI folder (`web/events.ts`, `web/avatars.ts`), so 15+ backend modules imported `web/`, and `web/avatars.ts` pulled in React. Two import cycles existed (integrations ↔ routines through the error classes, and the browser tools' context type). `host-server.ts` reached into private files of the handoffs and browser features. One `tsconfig.json` type-checked server code against DOM types. Nothing stopped any of this from coming back.

## Decision

- **Workspace packages.** The repo is Bun workspaces under `packages/`: `host` (the backend, whose code lives in `packages/host/src/`), `web` (the UI) and `contract`. Each package's `package.json` lists only the dependencies it imports. Paths below are relative to `packages/host/src/` unless they name a package.
- **Feature folders.** Each feature owns a folder under `src/`: `bots/`, `integrations/`, `routines/`, `credentials/`, `browser/`, `handoffs/`, plus `harness/` (Claude Code adapter and CLI) and `host-mcp/` (the request checks and serving shared by the host's MCP endpoints, ADR-0001). A folder's `index.ts` is its interface; every other file in it is private. A feature owns its tables and SQL in its own store.
- **Contract.** Types and data shared with the UI live in the `@claudebot/contract` package, `packages/contract/` (server events and the models they carry in `events.ts`, HTTP-only request and response shapes in `api.ts`, avatar data). Each shared shape is a Zod schema with its type derived by `z.infer`, so either side can parse what it receives. It imports nothing else local (npm packages such as `zod` are allowed); `packages/web/` imports no other package than it.
- **Platform.** `src/platform/` holds the database connection and migrations, secrets, tokens, the shared domain errors (`NotFound`, `InvalidInput`) and the JSON request-body reader (`InvalidBody`). It imports only `platform/` and `contract/`.
- **Composition root.** `src/host-server/index.ts` constructs the features, passes each its collaborators (database, event publisher, other features' interfaces) as arguments, and starts and stops them. `host-server/http.ts` holds the route table and the one `safe()` error wrapper; `host-server/api/<resource>.ts` decodes requests, calls a feature and encodes the response, each keeping its own error-to-status mapping.
- **Dependency direction.** Entrypoints (`server.ts`, `host.ts`) → `host-server` → features → `harness`, `host-mcp`, `platform`, `contract`. `web/` → `contract`.
- **Enforcement.** dependency-cruiser runs over all packages (`bun run depcheck`, part of `bun run check`) and fails on: any import cycle, type-only included; any orphan module, one nothing imports (except dotfile and `*.config.*` tool configs, `.d.ts` ambient declarations, tests and `browser/credential-plugin.ts`, which tools or subprocesses load by path rather than import); the host importing `packages/web/`; `packages/web/` importing any package but the contract; the contract package importing outside itself; `platform/` importing outside `platform/` and `contract/`; importing a module folder's private file from outside it (tests inside the folder may); production code importing tests or `src/testing/` (the `browser-smoke` subcommand only through a dynamic `import()`). Each package type-checks under its own `tsconfig.json` (the host and contract without DOM types, the web package with them).
- **Web package.** `packages/web/` follows the same shape (feature folders with one `index.ts`, a composition layer, enforced rules); see ADR-0004.

## Alternatives considered

- **Layer folders (`stores/`, `routes/`, `services/`).** Rejected: a change to one feature touches every layer folder, and nothing marks which store belongs to which feature, so features end up querying each other's tables.
- **Keeping shared types in `web/`.** Rejected: the backend would depend on the UI folder and its React imports, and server code would keep type-checking against DOM types.
- **Conventions without enforcement.** Rejected: the cycles and the private-file reach-ins this restructure removed were all written under conventions; a rule only holds if a check fails when it is broken.

## Consequences

- A caller sees a feature only through its `index.ts`; adding an operation means adding it there, not importing a store or helper.
- Cross-feature needs go through the composition root as arguments typed by an interface, so features stay testable with fakes and hold no module-level state.
- `browser/smoke.ts` imports `host-server/index.ts` to run a whole host; it is the one production module below the composition root that depends on it.
- New folders under `src/` that should be private need adding to the module list in `.dependency-cruiser.cjs`.
