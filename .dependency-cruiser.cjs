/**
 * Import rules for src/ and web/; see docs/adr/0003-feature-modules-and-dependency-rules.md.
 * Run with `bun run depcheck`.
 */
const TESTS = "(\\.test\\.tsx?$|^src/testing/)";

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
