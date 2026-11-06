/**
 * Import rules for the workspace packages; see docs/adr/0003-feature-modules-and-dependency-rules.md.
 * Run with `bun run depcheck`.
 */
const HOST = "^packages/host/src/";
const WEB = "^packages/web/";
const CONTRACT = "^packages/contract/";
const TESTS = `(\\.test\\.tsx?$|${HOST}testing/)`;
/** Folders under packages/host/src whose files are private behind index.ts. */
const MODULES =
  "(bots|browser|credentials|handoffs|harness|host-mcp|host-server|integrations|routines)";
const PRIVATE = `${HOST}${MODULES}/(?!index\\.ts$)`;
const HOST_SMOKE = `${HOST}browser/smoke\\.ts$`;
const HOST_CLI = `${HOST}host\\.ts$`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-orphans",
      comment: "Every module must be imported by something or be a known entry point.",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [
          // Dotfile configs (e.g. this file) are loaded by their tools, never imported.
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          // Tool configs (vite/vitest/playwright/...) are loaded by their CLIs, never imported.
          "(^|/)[^/]+\\.config\\.(js|cjs|mjs|ts)$",
          // Ambient declarations are picked up by tsconfig `include`, never imported.
          "\\.d\\.ts$",
          // Tests are run by the test runner, never imported.
          "\\.test\\.tsx?$",
          // Entry point: spawned as a subprocess by path from browser/login.ts (PLUGIN_SCRIPT).
          "^packages/host/src/browser/credential-plugin\\.ts$",
        ],
      },
      to: {},
    },
    {
      name: "no-cycles",
      comment: "Rule 1: no import cycles, type-only imports included.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "host-not-to-web",
      comment:
        "Rule 2: the host never imports the web package; shared types live in packages/contract/.",
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
      comment:
        "Rule 5: from outside a feature folder, import only its index.ts. Files in the same folder, tests included, may import its private files.",
      severity: "error",
      from: { path: `${HOST}([^/]+)`, pathNot: HOST_CLI },
      to: { path: PRIVATE, pathNot: `${HOST}$1/` },
    },
    {
      name: "host-cli-privacy",
      comment:
        "Rule 5 for the host CLI: only feature index.ts files, plus a dynamic import() of the browser-smoke subcommand.",
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
      comment:
        "Rule 6: production code never imports test files or testing/. The browser-smoke subcommand may load fakes through a dynamic import().",
      severity: "error",
      from: { path: "^packages/", pathNot: `${TESTS}|${HOST_SMOKE}` },
      to: { path: TESTS },
    },
    {
      name: "smoke-loads-fakes-dynamically",
      comment:
        "Rule 6: the browser-smoke subcommand reaches test support only through a dynamic import().",
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
