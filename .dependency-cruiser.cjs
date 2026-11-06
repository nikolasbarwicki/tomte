/**
 * Import rules for the workspace packages; see docs/adr/0003-feature-modules-and-dependency-rules.md.
 * Run with `bun run depcheck`.
 */
const HOST = "^packages/host/src/";
const WEB = "^packages/web/";
const CONTRACT = "^packages/contract/";
const WEB_FEATURES = `${WEB}features/`;
const WEB_SHARED = `${WEB}(components|hooks|lib|host)/`;
const WEB_UI = `${WEB}components/ui/`;
const WEB_APP = `${WEB}(app/|main\\.tsx$)`;
const WEB_FEATURE_PRIVATE = `${WEB_FEATURES}[^/]+/(?!index\\.ts$)`;
/** Web modules that stay free of React so they run under plain bun test. */
const WEB_PURE = `${WEB}(host/(state|transcript)\\.ts$|features/[^/]+/(model|schedule)\\.ts$)`;
const REACT = "node_modules/(@types/)?(react|react-dom)/";
const TESTS = `(\\.test\\.tsx?$|${HOST}testing/)`;
/** Folders under packages/host/src whose files are private behind index.ts. */
const MODULES = "(bots|browser|credentials|handoffs|harness|host-mcp|host-server|integrations|routines)";
const PRIVATE = `${HOST}${MODULES}/(?!index\\.ts$)`;
const HOST_SMOKE = `${HOST}browser/smoke\\.ts$`;
const HOST_CLI = `${HOST}host\\.ts$`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-cycles",
      comment: "Rule 1: no import cycles, type-only imports included.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "host-not-to-web",
      comment: "Rule 2: the host never imports the web package; shared types live in packages/contract/.",
      severity: "error",
      from: { path: HOST },
      to: { path: WEB },
    },
    {
      name: "web-only-to-contract",
      comment: "The web package imports no other workspace package than the contract.",
      severity: "error",
      from: { path: WEB },
      to: { path: "^packages/", pathNot: `${WEB}|${CONTRACT}` },
    },
    {
      name: "web-shared-not-to-features",
      comment: "Web shared code (components, hooks, lib, host) never imports features or app.",
      severity: "error",
      from: { path: WEB_SHARED },
      to: { path: `${WEB_FEATURES}|${WEB_APP}` },
    },
    {
      name: "web-ui-is-vendored-leaf",
      comment: "shadcn components/ui imports only itself, lib/, hooks/ and npm.",
      severity: "error",
      from: { path: WEB_UI },
      to: { path: WEB, pathNot: `${WEB_UI}|${WEB}(lib|hooks)/` },
    },
    {
      name: "web-features-not-to-app",
      comment: "Features never import app/; route data via getRouteApi, host data via host/ hooks.",
      severity: "error",
      from: { path: WEB_FEATURES },
      to: { path: WEB_APP },
    },
    {
      name: "web-feature-privacy",
      comment: "From outside a web feature folder, import only its index.ts.",
      severity: "error",
      from: { path: `${WEB_FEATURES}([^/]+)/|${WEB}(?!features/)` },
      to: { path: WEB_FEATURE_PRIVATE, pathNot: `${WEB_FEATURES}$1/` },
    },
    {
      name: "web-no-cross-feature",
      comment: "Features never import each other; app/ composes them.",
      severity: "error",
      from: { path: `${WEB_FEATURES}([^/]+)/` },
      to: { path: WEB_FEATURES, pathNot: `${WEB_FEATURES}$1/` },
    },
    {
      name: "web-routes-load-screens-lazily",
      comment: "The router loads screen routes only through dynamic import().",
      severity: "error",
      from: { path: `${WEB}app/router\\.tsx$` },
      to: { path: `${WEB}app/routes/.+\\.lazy\\.tsx$`, dependencyTypesNot: ["dynamic-import"] },
    },
    {
      name: "web-pure-models",
      comment: "Pure web models (host/state, host/transcript, features/*/model, features/*/schedule) import no React and no .tsx file.",
      severity: "error",
      from: { path: WEB_PURE },
      to: { path: `${REACT}|\\.tsx$` },
    },
    {
      name: "contract-is-standalone",
      comment: "Rule 3: the contract package imports nothing local outside itself.",
      severity: "error",
      from: { path: CONTRACT },
      to: { path: "^packages/", pathNot: CONTRACT },
    },
    {
      name: "platform-is-foundation",
      comment: "Rule 4: platform/ imports only platform/ and the contract package.",
      severity: "error",
      from: { path: `${HOST}platform/` },
      to: { path: "^packages/", pathNot: `${HOST}platform/|${CONTRACT}` },
    },
    {
      name: "feature-privacy",
      comment: "Rule 5: from outside a feature folder, import only its index.ts. Files in the same folder, tests included, may import its private files.",
      severity: "error",
      from: { path: `${HOST}([^/]+)`, pathNot: HOST_CLI },
      to: { path: PRIVATE, pathNot: `${HOST}$1/` },
    },
    {
      name: "host-cli-privacy",
      comment: "Rule 5 for the host CLI: only feature index.ts files, plus a dynamic import() of the browser-smoke subcommand.",
      severity: "error",
      from: { path: HOST_CLI },
      to: { path: PRIVATE, pathNot: HOST_SMOKE },
    },
    {
      name: "host-cli-loads-smoke-dynamically",
      comment: "Rule 5: the browser-smoke subcommand is loaded on demand, not at host startup.",
      severity: "error",
      from: { path: HOST_CLI },
      to: { path: HOST_SMOKE, dependencyTypesNot: ["dynamic-import"] },
    },
    {
      name: "production-not-to-tests",
      comment: "Rule 6: production code never imports test files or testing/. The browser-smoke subcommand may load fakes through a dynamic import().",
      severity: "error",
      from: { path: "^packages/", pathNot: `${TESTS}|${HOST_SMOKE}` },
      to: { path: TESTS },
    },
    {
      name: "smoke-loads-fakes-dynamically",
      comment: "Rule 6: the browser-smoke subcommand reaches test support only through a dynamic import().",
      severity: "error",
      from: { path: HOST_SMOKE },
      to: { path: TESTS, dependencyTypesNot: ["dynamic-import"] },
    },
  ],
  options: {
    parser: "swc",
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
  },
};
