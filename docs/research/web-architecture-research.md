# packages/web: architecture, modules, dependencies, dataflow, folder structure

Research date: 2026-11-06. Every cited URL was fetched and the claim matched against page text. **[RULE]** means the source documents it as a rule or as tool behavior. **[OPINION]** means an author's recommendation, or our judgment applying it to this repo.

Related: [ADR-0003](../adr/0003-feature-modules-and-dependency-rules.md) applies feature folders, `index.ts` interfaces, a composition root and dependency-cruiser enforcement to `packages/host`. None of it applies inside `packages/web` yet: the web package has only `no-cycles` and `web-only-to-contract`.

## 0. Current state (measured)

- **Flat root.** About 20 app files sit at the `packages/web/` root. The one feature folder is `integrations/`, whose pure `model.ts` and `model.test.ts` are the good precedent. Next to it are the vendored shadcn `components/ui/` (about 40 files), `hooks/` and `lib/utils.ts`.
- **Large files that mix concerns:**
  - `transcript.tsx` (471 lines) exports `type Item`, the pure `reduce()` and the `Transcript` view.
  - `chat.tsx` (404) takes about 12 props drilled from `router.tsx`.
  - `routines.tsx` (380) has 21 `useState`/`useEffect` calls.
  - `integrations/detail.tsx` (388).
- **Dataflow.** `shell.tsx` owns one `EventSource("/api/events")`, about 14 `useState`s and an `if (e.type …) setX` chain. It exposes a single `ShellContext` whose `value` is a new object literal on every render. `useShell()` is called only by route components in `router.tsx`, which pass slices down as props (`ChatView` takes about 12). Because all state lives in `Shell`, every streamed event re-renders `Shell`, `AppSidebar`, `NewBotDialog` and the mounted route's screen, including each `update` token. On `/credentials`, for example, chat tokens re-render the credentials screen.
- **Mutations.** `api.ts` `post`/`act` send POSTs without waiting for the result to show up; the host pushes the new state back over SSE (server-authoritative).
- **Dependencies:**
  - Every runtime dep in `package.json` is imported somewhere.
  - `shadcn` (the CLI) is in `dependencies`, but its only use is `@import "shadcn/tailwind.css"` in `tailwind.css`.
  - Nothing imports `components/ui/scroll-area.tsx`.

## 1. Folder structure and module boundaries

### What the sources say

- **React** ([legacy FAQ](https://legacy.reactjs.org/docs/faq-structure.html)) **[OPINION]** "Don't overthink it." Group by feature/route or by file type, and avoid nesting past "three or four nested folders within a single project".
- **Colocation**, Kent C. Dodds ([colocation](https://kentcdodds.com/blog/colocation), [state colocation](https://kentcdodds.com/blog/state-colocation-will-make-your-react-app-faster)) **[OPINION]**
  - "Place code as close to where it's relevant as possible."
  - Lift code only when a second consumer appears.
  - Global context that doesn't need to be global is a perf cost.
- **bulletproof-react** ([project-structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md)) **[OPINION]**
  - Layout: `app/` + `features/<name>/` + shared `components/ hooks/ lib/`.
  - Features don't import each other; the app level composes them.
  - Code flows "shared -> features -> app", enforced with ESLint `import/no-restricted-paths`.
  - It now advises against barrel files because of Vite cost.
- **Feature-Sliced Design** ([layers](https://feature-sliced.design/docs/reference/layers), [public API](https://feature-sliced.design/docs/reference/public-api)) **[RULE within the method]**
  - A module imports only from "layers strictly below".
  - Slices on the same layer don't cross-import.
  - Each slice has one public API.
  - Index files risk circular imports and broken tree-shaking, so `shared/ui` gets a per-component index rather than one barrel.
  - The full six-layer taxonomy is overkill at this size.
- **Vite** ([Avoid barrel files](https://vite.dev/guide/performance#avoid-barrel-files)) **[RULE]** In dev, importing one symbol from a barrel loads and transforms every re-exported file.
  - Measured evidence: [Marvin Hagemeister](https://marvinh.dev/blog/speeding-up-javascript-ecosystem-part-7/) and [Atlassian, 75% faster builds](https://www.atlassian.com/blog/atlassian-engineering/faster-builds-when-removing-barrel-files).
- **shadcn** ([docs](https://ui.shadcn.com/docs), [components.json](https://ui.shadcn.com/docs/components-json), [CLI](https://ui.shadcn.com/docs/cli)) **[RULE of the model]**
  - "Not a component library… it's how you build your component library."
  - The CLI copies source into `aliases.ui`, and you own those files.
  - **[OPINION]** Treat `components/ui` as a vendored leaf: keep edits minimal so `shadcn add --diff`/`--dry-run` stays useful, and put app-specific wrappers outside `ui/`.
- **TanStack Router**
  - [Code-based routing](https://tanstack.com/router/latest/docs/framework/react/routing/code-based-routing): "Code-based routing is not recommended for most applications. It is recommended to use File-Based Routing instead." It is still a supported API.
  - [Code splitting](https://tanstack.com/router/latest/docs/framework/react/guide/code-splitting) **[RULE]** Code-based routes split with `.lazy(() => import('./x.lazy'))` plus `createLazyRoute`. `autoCodeSplitting` exists only with file-based routing and the bundler plugin.
  - [`getRouteApi('/path')`](https://tanstack.com/router/latest/docs/framework/react/guide/code-splitting#manually-accessing-route-apis-in-other-files-with-the-getrouteapi-helper) gives typed params and search without importing the route object, so screens never import `router.tsx`.

### Options compared

| Option                                                                                                                                                                              | Boundary unit                | Fit for this package                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| Flat (current)                                                                                                                                                                      | none                         | Outgrown: no ownership signal, and mixed 400-line files           |
| By type (`components/ hooks/ utils/`)                                                                                                                                               | technical layer              | Poor: features scatter, and ADR-0003 rejected this for host       |
| **Feature folders + shared (bulletproof)**                                                                                                                                          | feature folder, one-way flow | **Best fit**: mirrors host features and ADR-0003                  |
| FSD                                                                                                                                                                                 | slice public API             | Overkill; borrow "no same-layer cross-imports" and the public API |
| TanStack file-based routes                                                                                                                                                          | route file                   | Optional; buys auto code-split at the cost of codegen             |
| Sub-packages / TS project refs ([exports](https://nodejs.org/api/packages.html#package-entry-points), [refs](https://www.typescriptlang.org/docs/handbook/project-references.html)) | package                      | Not warranted inside web; already used for `contract`             |

### Proposed layout [OPINION]

```
packages/web/
  main.tsx                     # entry
  app/                         # composition root: router.tsx, shell.tsx, app-sidebar.tsx, welcome.tsx
  host/                        # host connection: store, stream, slice hooks, api commands (§2)
  features/
    chat/                      # chat.tsx, mentions.ts, transcript/{model.ts, model.test.ts, view.tsx}
    bots/                      # bot-panel.tsx, new-bot.tsx, bot-avatar.tsx, avatars.ts
    browser/                   # browser-panel.tsx
    routines/                  # routines.tsx, schedule.ts
    credentials/               # credentials.tsx
    integrations/              # existing folder, unchanged inside
  components/ui/               # vendored shadcn leaf, no index
  components/                  # app-wide non-shadcn: confirm.tsx, page.tsx
  hooks/  lib/                 # format.ts, utils.ts
```

This layout does not pass the boundary rules as-is. Today's imports that would cross features or reach private files:

- `chat.tsx` → `bot-panel.tsx`, `avatars.ts`, `bot-avatar.tsx` (chat → bots).
- `bot-panel.tsx` → `browser-panel.tsx`, `routines.tsx` (bots → browser, bots → routines).
- `app-sidebar.tsx` → `bot-avatar.tsx` (app → a bots private file).
- `shell.tsx` → `integrations/model.ts`, and `router.tsx` → `integrations/screen.tsx` (app → integrations private files; `integrations/` has no `index.ts`).

`web-feature-privacy` fails until each feature has an `index.ts` and every outside importer uses it. `web-no-cross-feature` fails until the panel nesting is removed. Either compose the panels in `app/`, passing `BrowserPanel`/`Routines` into `BotPanel` and `BotPanel` into `ChatView` as slots, or merge `bot-panel`, `browser-panel` and the routines panel into `chat/`. In both cases `avatars.ts`/`bot-avatar.tsx` move to shared code. Do the moves and the index files before turning the rules on.

### Boundary rules

1. One-way flow: shared (`components`, `hooks`, `lib`, `host`) → `features/*` → `app`.
2. `components/ui` imports only itself, `lib/`, `hooks/` and npm packages.
3. Features don't import `app/`. They read route data through `getRouteApi` and host state through `host/` hooks, not `useShell()`.
4. A feature's private files are reachable from outside only through its `index.ts(x)`, the same as host rule 5. Each index has named exports only, no `export *`. There is no index in `components/ui`, `hooks` or `lib`.
5. Pure logic (`model.ts`) has no React imports. Views import the model, never the reverse.
6. Optional, stricter: features never cross-import, and `app/` composes them.

### Enforcement: dependency-cruiser (proved on a throwaway fixture)

A throwaway config in `/tmp/web-dc/` used `require()` to load the repo's `.dependency-cruiser.cjs`, kept its rules and added the rules below, with the `.lazy.tsx` exception and `web-no-cross-feature` enabled. It ran on a fake `packages/web/{app,features/a,features/b,components/ui,lib}` tree. The repo config was not changed, and none of these rules have been run against the real `packages/web`.

- Good tree: `no dependency violations found (8 modules, 8 dependencies)`.
- Bad tree: all 8 expected errors fired, one or more per rule.
- The first run flagged a legitimate dynamic `import()` of a `*.lazy.tsx` route. The privacy regex below fixes that.

```js
const WEB_FEATURES = `${WEB}features/`;
const WEB_SHARED = `${WEB}(components|hooks|lib|host)/`;
const WEB_UI = `${WEB}components/ui/`;
const WEB_APP = `${WEB}(app/|main\\.tsx$)`;
const WEB_FEATURE_PRIVATE = `${WEB_FEATURES}[^/]+/(?!index\\.tsx?$|[^/]+\\.lazy\\.tsx$)`;

{ name: "web-shared-not-to-features", severity: "error",
  from: { path: WEB_SHARED }, to: { path: `${WEB_FEATURES}|${WEB_APP}` } },
{ name: "web-ui-is-vendored-leaf", severity: "error",
  from: { path: WEB_UI }, to: { path: WEB, pathNot: `${WEB_UI}|${WEB}(lib|hooks)/` } },
{ name: "web-features-not-to-app", severity: "error",
  from: { path: WEB_FEATURES }, to: { path: WEB_APP } },
{ name: "web-feature-privacy", severity: "error",
  from: { path: `${WEB_FEATURES}([^/]+)/|${WEB}(?!features/)` },
  to: { path: WEB_FEATURE_PRIVATE, pathNot: `${WEB_FEATURES}$1/` } },
// Optional, strict bulletproof:
{ name: "web-no-cross-feature", severity: "error",
  from: { path: `${WEB_FEATURES}([^/]+)/` }, to: { path: WEB_FEATURES, pathNot: `${WEB_FEATURES}$1/` } },
// Only if adopting .lazy() routes:
{ name: "web-routes-load-screens-lazily", severity: "error",
  from: { path: `${WEB}app/router[^/]*\\.tsx$` }, to: { path: "\\.lazy\\.tsx$", dependencyTypesNot: ["dynamic-import"] } },
```

- The fixture omitted `host/` from `WEB_SHARED`; adding it to the pattern is untested.
- `$1` back-references and `dependencyTypesNot` are documented in the [rules reference](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md).
- A rule "`model.ts` imports no `react`" needs a `to: { path: "^react" }` rule on resolved `node_modules` paths [INFERENCE: not tested].
- Alternatives exist: [eslint-plugin-boundaries](https://github.com/javierbrea/eslint-plugin-boundaries), [`import/no-restricted-paths`](https://github.com/import-js/eslint-plugin-import/blob/main/docs/rules/no-restricted-paths.md), Biome [`noBarrelFile`](https://biomejs.dev/linter/rules/no-barrel-file/)/[`noReExportAll`](https://biomejs.dev/linter/rules/no-re-export-all/) and [Steiger](https://github.com/feature-sliced/steiger). **[OPINION]** Keep dependency-cruiser as the single enforcer, per ADR-0003.

## 2. Dataflow and state

### What the sources say

- **Minimal state, derive the rest.** [Thinking in React](https://react.dev/learn/thinking-in-react) ("minimal but complete") and [choosing state structure](https://react.dev/learn/choosing-the-state-structure): group state that changes together and avoid redundant state. **[RULE]**
- **Reducers when many handlers touch state.** The [reducer guide](https://react.dev/learn/extracting-state-logic-into-a-reducer) says this, and the `reset` event sets four `useState`s at once. **[RULE]** "Reducers must be pure."
- **Context costs.** Every consumer re-renders when `value` changes by `Object.is`, so memoize the value or split the contexts ([useContext](https://react.dev/reference/react/useContext#optimizing-re-renders-when-passing-objects-and-functions), [reducer + context](https://react.dev/learn/scaling-up-with-reducer-and-context)). **[RULE]**
- **External sources.** For an external source, `useSyncExternalStore` is tearing-safe; `getSnapshot` must return a cached value ([ref](https://react.dev/reference/react/useSyncExternalStore), [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect#subscribing-to-an-external-store)). **[RULE]**
- **Long-lived handlers.** They read the latest values through refs ([refs](https://react.dev/learn/referencing-values-with-refs)) or [`useEffectEvent`](https://react.dev/reference/react/useEffectEvent), stable since [React 19.2](https://react.dev/blog/2025/10/01/react-19-2). **[RULE]**
- **Try props before context.** Try plain props or `children` composition before context ([before you use context](https://react.dev/learn/passing-data-deeply-with-context#before-you-use-context)). **[RULE]**
- **Redux style guide.** "[Model actions as events, not setters](https://redux.js.org/style-guide/#model-actions-as-events-not-setters)" and "[put as much logic as possible in reducers](https://redux.js.org/style-guide/#put-as-much-logic-as-possible-in-reducers)". The contract's `ServerEvent` union is already event-shaped; Shell's `if … setX` chain turns it back into setters.
- **Server state vs client state.** Server state is remote, shared and can go stale ([TanStack Query overview](https://tanstack.com/query/latest/docs/framework/react/overview)). Push events can write into a cache ([TkDodo](https://tkdodo.eu/blog/using-web-sockets-with-react-query)). **[OPINION]** Query adds little here, because every slice arrives as a full snapshot by push with no fetch-on-mount. Keep the split itself: host state in a store, UI state (`draft`, `newBotOpen`) in React.
- **External stores with selectors** (Zustand [createStore](https://zustand.docs.pmnd.rs/reference/apis/create-store), [useShallow](https://zustand.docs.pmnd.rs/learn/guides/prevent-rerenders-with-use-shallow)) re-render only on a change in the selected slice. A hand-rolled store of about 30 lines plus `useSyncExternalStore` does the same with no dependency.
- **TanStack Router.**
  - [Router context](https://tanstack.com/router/latest/docs/framework/react/guide/router-context) (`createRootRouteWithContext<T>()`) is its documented DI mechanism.
  - [Search params](https://tanstack.com/router/latest/docs/framework/react/guide/search-params) are typed, validated state.
  - **[OPINION]** [Loaders](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading) don't fit push-fed data.
- **Mutations.**
  - React 19 [Actions](https://react.dev/blog/2024/12/05/react-19#actions), [`useTransition`](https://react.dev/reference/react/useTransition) and [`useActionState`](https://react.dev/reference/react/useActionState) give pending and error state.
  - [`useOptimistic`](https://react.dev/reference/react/useOptimistic) reverts when the action settles. **[OPINION]** So it flickers if the SSE push arrives after the POST resolves.
- **SSE reconnect.** EventSource reconnects on its own ([`retry`/`Last-Event-ID`](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-eventsource-interface)). With full-snapshot events, a reconnect just re-applies the snapshots.
- **Functional core, imperative shell** ([Gary Bernhardt](https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell)): pure decisions sit in the core; I/O stays at a thin edge.

### One stream → many slices

|                             | Big context (today)            | Split contexts                      | External store + selectors      |
| --------------------------- | ------------------------------ | ----------------------------------- | ------------------------------- |
| Re-render on `update` token | Shell, sidebar, mounted screen | transcript consumers, if split well | only `useChat()` users          |
| Stream ownership            | component effect               | component effect                    | store, started once             |
| Testability                 | needs render                   | needs render                        | pure: feed events, assert state |
| Cost                        | 0                              | N providers                         | about 30 LOC, no dependency     |

### Target design [OPINION, built on the rules above]

```ts
// host/state.ts: pure core, no React. Tested in host/state.test.ts.
export type HostState = {
  info?: HostInfo;
  bots?: BotSummary[];
  openBotId?: string;
  chat: { items: Item[]; busy: boolean; context?: ContextEvent };
  memory: Record<MemoryScope, string>;
  files: FilesEvent;
  routines?: RoutinesEvent;
  integrations: Integration[];
  credentials: CredentialEntry[];
  notices: Notice[];
};
export function applyEvent(s: HostState, e: StreamEvent): HostState; // composes the transcript reduce() for chat.items

// host/store.ts: about 30 lines of get/subscribe/dispatch.
// host/stream.ts: imperative edge. EventSource → dispatch; toast on notify; onReset callback (Shell passes navigate).
// host/hooks.ts: per-slice selectors.
// Not exported: getSnapshot must return a cached value, and `() => sel(store.get())` is cached only when `sel` returns
// an existing reference from the immutable state. Keeping useHost private limits selectors to the field reads below.
// Derived values (filters, counts) are computed in render or with useMemo over a slice, never inside a selector.
const useHost = <T>(sel: (s: HostState) => T) =>
  useSyncExternalStore(store.subscribe, () => sel(store.get()));
export const useBots = () => useHost((s) => s.bots);
export const useChat = () => useHost((s) => s.chat);
// host/api.ts: today's post/act/errorOf, plus typed commands (openBot, sendMessage…) so screens hold no URL strings.
```

- `shell.tsx` keeps only UI state (`newBotOpen`, `draft`) and the `connectHostStream` effect. `ShellContext` and the 14 `useState`s go away.
- Screens call slice hooks themselves. One level of props from route to screen is fine; the fix is to stop the fan-out to every consumer, not to delete every prop.
- `act()` callers wrap commands in `startTransition` to show pending state. The host stays authoritative, so don't add optimistic copies by default.
- Search-param candidates: the panel and tab toggles in `bot-panel.tsx`/`browser-panel.tsx`, and possibly `draft`. `zod` is already a dependency.

## 3. Composition and module design

- **Composition over prop explosion.** Pass JSX as `children` or slots so intermediate components need not forward data ([passing JSX](https://react.dev/learn/passing-props-to-a-component#passing-jsx-as-children)). **[RULE]**
  - "A component should ideally only be concerned with one thing. If it ends up growing, it should be decomposed" ([Thinking in React](https://react.dev/learn/thinking-in-react#step-1-break-the-ui-into-a-component-hierarchy)).
  - Never define components inside components ([nesting](https://react.dev/learn/your-first-component#nesting-and-organizing-components)).
- **Custom hooks share stateful logic, not state.** Extract one when an Effect syncs with an external system ([custom hooks](https://react.dev/learn/reusing-logic-with-custom-hooks)). **[RULE]** Candidate: the form state in `routines.tsx`.
- **Purity.** Components and hooks must be pure ([rules](https://react.dev/reference/rules/components-and-hooks-must-be-pure)). **[RULE]**
- **Don't split by container vs presentational.** Abramov's 2019 update to [Smart and Dumb Components](https://medium.com/@dan_abramov/smart-and-dumb-components-7ca2f9a7c7d0): "I don't suggest splitting your components like this anymore." **[OPINION]** Split pure functions and reducers (`model.ts`) from views instead.
- **Compound/headless components.** Base UI composes through `render` props and `<X.Root><X.Trigger/>` parts ([composition](https://base-ui.com/react/handbook/composition)); see also [compound components](https://kentcdodds.com/blog/compound-components-with-react-hooks). **[OPINION]** Use this in app code where a screen otherwise takes 10 or more props.
- **Fast Refresh.** It preserves state only for modules that export only components ([plugin-react](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#consistent-components-exports)). **[RULE]** Type-only exports like `Item` are erased and don't count. The runtime `reduce` export in `transcript.tsx` does count, so every edit to the file fully reloads it. Splitting out `model.ts` fixes both the mixed concerns and the reload.
- **Split by reason to change, not by line count.** **[OPINION]** Splitting a domain reducer from its view from its hooks is what matters; around 300–400 lines with several exported concerns is the practical trigger.
- **Testing.** "The more your tests resemble the way your software is used, the more confidence they can give you" ([Testing Library](https://testing-library.com/docs/guiding-principles)).
  - **[OPINION]** The highest-ROI tests here are pure: `applyEvent`, `reduce`, `model.ts`, `schedule.ts`, `mentions.ts`, `format.ts` with `bun:test`.
  - Add happy-dom through `bunfig.toml` preload ([Bun DOM testing](https://bun.sh/docs/test/dom)) only for interaction-heavy screens.

## 4. Dependency hygiene

- `dependencies` vs `devDependencies` ([npm](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#devdependencies)). **[OPINION]** For a bundled Vite SPA the split is informational, but the `shadcn` CLI is semantically a dev tool; move it to `devDependencies`.
- Delete the unused `components/ui/scroll-area.tsx`.
- [knip](https://knip.dev/) finds unused files, exports and deps, and unlisted deps. It is workspace-aware and has [Vite](https://knip.dev/reference/plugins/vite) and [Tailwind](https://knip.dev/reference/plugins/tailwind) plugins. Bun hoists workspace deps to the root ([workspaces](https://bun.sh/docs/install/workspaces)), so an undeclared import can resolve silently. **[OPINION]** Add `knip` to `bun run check`, next to `depcheck`; this matches ADR-0003's stance of enforced rules over conventions.

## 5. Prioritized moves for packages/web [OPINION]

| #   | Move                                                                                     | Why                                                                                            | Files                                                                         |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Split `transcript.tsx` into `model.ts` (`Item`, `reduce`, test) and a view               | Pure core, Fast Refresh, precedent in `integrations/model.ts`                                  | `transcript.tsx`, `transcript.test.ts`                                        |
| 2   | Host store with `applyEvent` and slice hooks; delete `ShellContext`                      | Stops re-rendering `Shell`, `AppSidebar` and the mounted screen per token; reducer is testable | `shell.tsx`, `router.tsx`, `api.ts`                                           |
| 3   | Move into `app/`, `features/*` and shared folders                                        | Ownership, colocation, mirrors host                                                            | all root files, `components.json` aliases                                     |
| 4   | Add web rules to `.dependency-cruiser.cjs` and write an ADR next to 0003                 | Conventions without checks don't hold (ADR-0003)                                               | `.dependency-cruiser.cjs`, `docs/adr/`                                        |
| 5   | Screens read params with `getRouteApi`; mutations use `startTransition`/`useActionState` | No screen → router imports; pending UI                                                         | `chat.tsx`, `credentials.tsx`, `routines.tsx`, `integrations/custom-form.tsx` |
| 6   | Run knip, move `shadcn` to devDeps, delete `scroll-area.tsx`                             | Dependency hygiene                                                                             | `package.json`, `components/ui/`                                              |
| 7   | Optional: `.lazy()` routes or file-based routing                                         | Bundle splitting; TanStack recommends file-based                                               | `router.tsx`                                                                  |

Order matters: step 1 is independent and makes the reducer a reusable piece for step 2. Settle step 2 before or with step 3. Once screens move into `features/*` and read state themselves, they must get it from `host/` hooks: if they import `useShell()` from `app/shell.tsx`, step 4's `web-features-not-to-app` rule fails.
