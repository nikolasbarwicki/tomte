#!/usr/bin/env bun
// Fake `agent-browser` implementing the `--json` CLI contract the host uses. Point AGENT_BROWSER_PATH at this file.
// Like the real engine it enforces `--action-policy`, so a host command missing from the allow list fails here too.
//
// FAKE_AGENT_BROWSER_DIR holds everything the fake reads and writes:
//   script.json  (optional) { pages: { [url]: { title?, snapshot, text?, selectors?: { [css]: snapshot } } }, onAction?: { ["click @e1"]: nextUrl }, fail?: { [command]: message }, delayMs?: { [command]: number },
//                logins?: { [signInUrl]: { username, password, then: nextUrl, error?: message } } }
//   calls.jsonl  one line per invocation: { argv, env: { AGENT_BROWSER_ENCRYPTION_KEY, AGENT_BROWSER_PLUGINS } }
//   state.json   the current page per session; a session listed here has an open browser
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Page {
  title?: string;
  snapshot: string;
  text?: string;
  selectors?: Record<string, string>;
}
interface Script {
  /** `open` fetches the URL through the engine's --proxy first, as the real browser does. */
  viaProxy?: boolean;
  pages?: Record<string, Page>;
  /** An action line (`click @e1`) that navigates the session to another page. */
  onAction?: Record<string, string>;
  fail?: Record<string, string>;
  delayMs?: Record<string, number>;
  streamPort?: number;
  /** `open` of a URL that lands on another one, like a server redirect. */
  redirects?: Record<string, string>;
  /** What `auth login` does on a sign-in page: with the right credential the session moves to `then`; with another the page stays. `error` makes the engine fail after filling. */
  logins?: Record<string, { username: string; password: string; then: string; error?: string }>;
}

const dir = process.env.FAKE_AGENT_BROWSER_DIR;
if (!dir) {
  console.error("FAKE_AGENT_BROWSER_DIR is not set");
  process.exit(2);
}
const read = <T>(name: string, fallback: T): T => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : fallback);

const argv = process.argv.slice(2);
// Sweeps list sessions on a timer; they are not calls a test cares about.
if (!argv.includes("list")) appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ argv, env: { AGENT_BROWSER_ENCRYPTION_KEY: process.env.AGENT_BROWSER_ENCRYPTION_KEY, AGENT_BROWSER_PLUGINS: process.env.AGENT_BROWSER_PLUGINS } }) + "\n");

const flagsWithValue = new Set(["--session", "--restore", "--executable-path", "--idle-timeout", "--action-policy", "--proxy", "--args", "--credential-provider", "--item", "--url"]);
const flags: Record<string, string> = {};
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (flagsWithValue.has(argv[i])) flags[argv[i]] = argv[++i];
  else if (argv[i] === "--json" || argv[i] === "--headed" || argv[i] === "--no-navigate") flags[argv[i]] = "true";
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

/** The engine action each implemented command runs, as the real engine names it in policy denials; undefined when the policy never sees it. */
function engineAction(): string | undefined {
  switch (command) {
    case "open":
      return "navigate";
    case "get":
      return `get${args[0]}`;
    case "tab":
      return ["list", "new", "close"].includes(args[0]) ? `tab_${args[0]}` : "tab_switch";
    case "stream":
      return `stream_${args[0]}`;
    case "auth":
      return `auth_${args[0]}`;
    case "session":
      // The engine answers `session list` itself, without the policy (it succeeds even when explicitly denied).
      return undefined;
    default:
      return command;
  }
}

// Enforces --action-policy like the real engine: the deny list wins, then the allow list, then the default.
function checkPolicy(action: string | undefined) {
  if (!flags["--action-policy"] || !action) return;
  const policy = JSON.parse(readFileSync(flags["--action-policy"], "utf8")) as { default: "allow" | "deny"; allow?: string[]; deny?: string[] };
  if (policy.deny?.includes(action)) fail(`Action '${action}' denied by policy: Action '${action}' is denied by policy`);
  if (policy.default === "deny" && !policy.allow?.includes(action)) fail(`Action '${action}' denied by policy: Action '${action}' is not in the allow list`);
}
checkPolicy(engineAction());

/** `auth login` as the real engine does it: asks the credential plugin, refuses a page whose origin differs from the credential's with --no-navigate, fills, and reports success even when the site then shows another form. */
async function authLogin() {
  const [, name] = args;
  const provider = flags["--credential-provider"];
  const url = flags["--url"];
  const plugin = (JSON.parse(process.env.AGENT_BROWSER_PLUGINS ?? "[]") as { name: string; command: string; args?: string[] }[]).find((p) => p.name === provider);
  if (!plugin || !url) fail("unknown credential provider");
  if (flags["--no-navigate"]) {
    const here = state[session] ? new URL(state[session]).origin : "about:blank";
    if (here !== new URL(url).origin) fail(`Current page origin ${here} does not match credential origin ${new URL(url).origin}`);
  }
  checkPolicy(`plugin:${provider}:credential.read`);
  const child = Bun.spawn([plugin!.command, ...(plugin!.args ?? [])], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  child.stdin.write(JSON.stringify({ protocol: "agent-browser.plugin.v1", type: "credential.resolve", capability: "credential.read", request: { profileName: name, itemRef: flags["--item"], url } }));
  child.stdin.end();
  const answer = JSON.parse((await new Response(child.stdout).text()) || "{}") as { success?: boolean; credential?: { username: string; password: string } };
  if (!answer.success || !answer.credential) fail("credential provider failed");
  const expected = script.logins?.[url!];
  if (expected?.error) fail(expected.error);
  if (expected && answer.credential!.username === expected.username && answer.credential!.password === expected.password) {
    state[session] = expected.then;
    writeFileSync(join(dir!, "state.json"), JSON.stringify(state));
  }
  reply({ loggedIn: true, name });
}

await Bun.sleep(script.delayMs?.[command] ?? 0);
if (script.fail?.[command]) fail(script.fail[command]);

switch (command) {
  case "open": {
    if (script.viaProxy && flags["--proxy"]) await fetch(args[0], { proxy: flags["--proxy"] }).then((r) => r.arrayBuffer());
    state[session] = script.redirects?.[args[0]] ?? args[0];
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    reply({ title: pageAt(state[session]).title ?? "", url: state[session] });
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
  case "session": {
    // `session list` names every session with an open browser; tests seed orphans by writing state.json.
    if (args[0] !== "list") fail("Unknown session command");
    reply({ sessions: Object.keys(state) });
    break;
  }
  case "get": {
    const url = state[session];
    if (!url) fail("No page is open");
    reply({ origin: url, text: pageAt(url).text ?? "" });
    break;
  }
  case "screenshot":
    writeFileSync(args[0], "png");
    reply({ path: args[0] });
    break;
  case "tab":
    reply({ tabs: state[session] ? [{ active: true, tabId: "t1", title: pageAt(state[session]).title ?? "", type: "page", url: state[session] }] : [] });
    break;
  case "click":
  case "fill":
  case "type":
  case "press":
  case "select":
  case "scroll":
  case "scrollintoview":
  case "back": {
    const next = script.onAction?.[[command, ...args].join(" ")];
    if (next) {
      state[session] = next;
      writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    }
    reply({ done: command });
    break;
  }
  case "auth":
    if (args[0] !== "login") fail("Unknown auth command");
    await authLogin();
    break;
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
