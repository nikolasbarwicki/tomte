#!/usr/bin/env bun
// Fake `agent-browser` implementing the `--json` CLI contract the host uses. Point AGENT_BROWSER_PATH at this file.
//
// FAKE_AGENT_BROWSER_DIR holds everything the fake reads and writes:
//   script.json  (optional) { pages: { [url]: { title?, snapshot, selectors?: { [css]: snapshot } } }, fail?: { [command]: message }, delayMs?: { [command]: number } }
//   calls.jsonl  one line per invocation: { argv, env: { AGENT_BROWSER_ENCRYPTION_KEY } }
//   state.json   the current page per session
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Page {
  title?: string;
  snapshot: string;
  selectors?: Record<string, string>;
}
interface Script {
  /** `open` fetches the URL through the engine's --proxy first, as the real browser does. */
  viaProxy?: boolean;
  pages?: Record<string, Page>;
  fail?: Record<string, string>;
  delayMs?: Record<string, number>;
  streamPort?: number;
}

const dir = process.env.FAKE_AGENT_BROWSER_DIR;
if (!dir) {
  console.error("FAKE_AGENT_BROWSER_DIR is not set");
  process.exit(2);
}
const read = <T>(name: string, fallback: T): T => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : fallback);

const argv = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ argv, env: { AGENT_BROWSER_ENCRYPTION_KEY: process.env.AGENT_BROWSER_ENCRYPTION_KEY } }) + "\n");

const flagsWithValue = new Set(["--session", "--restore", "--executable-path", "--proxy", "--args"]);
const flags: Record<string, string> = {};
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (flagsWithValue.has(argv[i])) flags[argv[i]] = argv[++i];
  else if (argv[i] === "--json") flags["--json"] = "true";
  else rest.push(argv[i]);
}
const [command, ...args] = rest;
const session = flags["--session"] ?? "default";

const reply = (data: unknown) => console.log(JSON.stringify({ success: true, data, error: null }));
const fail = (error: string) => {
  console.log(JSON.stringify({ success: false, data: null, error }));
  process.exit(1);
};

const script = read<Script>("script.json", {});
const state = read<Record<string, string>>("state.json", {});
const pageAt = (url: string): Page => script.pages?.[url] ?? { title: "Fake page", snapshot: `- heading "Fake page for ${url}" [ref=e1]` };

await Bun.sleep(script.delayMs?.[command] ?? 0);
if (script.fail?.[command]) fail(script.fail[command]);

switch (command) {
  case "open": {
    if (script.viaProxy && flags["--proxy"]) await fetch(args[0], { proxy: flags["--proxy"] }).then((r) => r.arrayBuffer());
    state[session] = args[0];
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    reply({ title: pageAt(args[0]).title ?? "", url: args[0] });
    break;
  }
  case "snapshot": {
    const url = state[session];
    if (!url) fail("No page is open");
    const page = pageAt(url);
    const selector = args.includes("-s") ? args[args.indexOf("-s") + 1] : undefined;
    let snapshot = page.snapshot;
    if (selector) {
      if (!page.selectors?.[selector]) fail(`Selector '${selector}' did not match any element`);
      snapshot = page.selectors![selector];
    }
    if (args.includes("-i")) snapshot = snapshot.split("\n").filter((l) => l.includes("[ref=")).join("\n");
    reply({ origin: url, refs: {}, removedRefs: [], snapshot });
    break;
  }
  case "close":
    delete state[session];
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    reply({ closed: true });
    break;
  case "stream":
    reply({ enabled: script.streamPort !== undefined, port: script.streamPort ?? null });
    break;
  default:
    fail(`Unknown command: ${command}`);
}
