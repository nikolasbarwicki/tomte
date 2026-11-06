/**
 * Import rules for src/ and web/; see docs/adr/0003-feature-modules-and-dependency-rules.md.
 * Run with `bun run depcheck`.
 */
const TESTS = "(\\.test\\.tsx?$|^src/testing/)";
/** Folders whose files are private behind index.ts. */
const MODULES = "(bots|browser|credentials|handoffs|harness|host-mcp|host-server|integrations|routines)";
const PRIVATE = `^src/${MODULES}/(?!index\\.ts$)`;

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
      name: "server-not-to-web",
      comment: "Rule 2: the backend never imports the UI folder; shared types live in src/contract/.",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^web/" },
    },
    {
      name: "web-only-to-contract",
      comment: "The UI imports from src/ only through src/contract/.",
      severity: "error",
      from: { path: "^web/" },
      to: { path: "^src/", pathNot: "^src/contract/" },
    },
    {
      name: "contract-is-standalone",
      comment: "Rule 3: src/contract/ imports nothing local outside itself.",
      severity: "error",
      from: { path: "^src/contract/" },
      to: { path: "^(src|web)/", pathNot: "^src/contract/" },
    },
    {
      name: "platform-is-foundation",
      comment: "Rule 4: src/platform/ imports only platform/ and contract/.",
      severity: "error",
      from: { path: "^src/platform/" },
      to: { path: "^(src|web)/", pathNot: "^src/(platform|contract)/" },
    },
    {
      name: "feature-privacy",
      comment: "Rule 5: from outside a feature folder, import only its index.ts. Files in the same folder, tests included, may import its private files.",
      severity: "error",
      from: { path: "^src/([^/]+)", pathNot: "^src/host\\.ts$" },
      to: { path: PRIVATE, pathNot: "^src/$1/" },
    },
    {
      name: "host-cli-privacy",
      comment: "Rule 5 for the host CLI: only feature index.ts files, plus a dynamic import() of the browser-smoke subcommand.",
      severity: "error",
      from: { path: "^src/host\\.ts$" },
      to: { path: PRIVATE, pathNot: "^src/browser/smoke\\.ts$" },
    },
    {
      name: "host-cli-loads-smoke-dynamically",
      comment: "Rule 5: the browser-smoke subcommand is loaded on demand, not at host startup.",
      severity: "error",
      from: { path: "^src/host\\.ts$" },
      to: { path: "^src/browser/smoke\\.ts$", dependencyTypesNot: ["dynamic-import"] },
    },
    {
      name: "production-not-to-tests",
      comment: "Rule 6: production code never imports test files or src/testing/. The browser-smoke subcommand may load fakes through a dynamic import().",
      severity: "error",
      from: { path: "^(src|web)/", pathNot: `${TESTS}|^src/browser/smoke\\.ts$` },
      to: { path: TESTS },
    },
    {
      name: "smoke-loads-fakes-dynamically",
      comment: "Rule 6: the browser-smoke subcommand reaches test support only through a dynamic import().",
      severity: "error",
      from: { path: "^src/browser/smoke\\.ts$" },
      to: { path: TESTS, dependencyTypesNot: ["dynamic-import"] },
    },
  ],
  options: {
    parser: "swc",
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
  },
};
