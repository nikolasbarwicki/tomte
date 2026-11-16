#!/usr/bin/env bun
// Fake `agent-browser` implementing the `--json` CLI contract the host uses. Point AGENT_BROWSER_PATH at this file.
// Like the real engine it enforces `--action-policy`, so a host command missing from the allow list fails here too.
//
// FAKE_AGENT_BROWSER_DIR holds everything the fake reads and writes:
//   script.json  (optional) { pages: { [url]: { title?, snapshot, text?, selectors?: { [css]: snapshot }, later?: { snapshot, title? }[] } }, onAction?: { ["click @e1"]: nextUrl }, fail?: { [command]: message }, delayMs?: { [command]: number },
//                logins?: { [signInUrl]: { username, password, next: nextUrl, error?: message } } }
//                A page's `later` lists what each `snapshot` call after the first returns (the last entry repeats): a page whose snapshot differs on each call, such as a bot wall that clears while it is waited out. Opening the page or navigating to it starts the count again; `tab list` reports the title of the view the latest `snapshot` returned.
//   calls.jsonl  one line per invocation: { argv, env: { AGENT_BROWSER_ENCRYPTION_KEY, AGENT_BROWSER_PLUGINS } }
//   state.json   the current page per session; a session listed here has an open browser
//   views.json   how many `snapshot` calls a session's current page has answered, for pages with `later`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defined } from "./defined.ts";

interface Page {
  title?: string;
  snapshot: string;
  text?: string;
  selectors?: Record<string, string>;
  later?: { snapshot: string; title?: string }[];
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
  /** What `auth login` does on a sign-in page: with the right credential the session moves to `next`; with another the page stays. `error` makes the engine fail after filling. */
  logins?: Record<string, { username: string; password: string; next: string; error?: string }>;
}

const envDir = process.env.FAKE_AGENT_BROWSER_DIR;
if (!envDir) {
  console.error("FAKE_AGENT_BROWSER_DIR is not set");
  process.exit(2);
}
const dir: string = envDir;
const read = <T>(name: string, fallback: T): T =>
  existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : fallback;

const argv = process.argv.slice(2);
// Sweeps list sessions on a timer; they are not calls a test cares about.
if (!argv.includes("list"))
  appendFileSync(
    join(dir, "calls.jsonl"),
    JSON.stringify({
      argv,
      env: {
        AGENT_BROWSER_ENCRYPTION_KEY: process.env.AGENT_BROWSER_ENCRYPTION_KEY,
        AGENT_BROWSER_PLUGINS: process.env.AGENT_BROWSER_PLUGINS,
      },
    }) + "\n",
  );

const flagsWithValue = new Set([
  "--session",
  "--restore",
  "--executable-path",
  "--idle-timeout",
  "--action-policy",
  "--proxy",
  "--args",
  "--credential-provider",
  "--item",
  "--url",
]);
const flags: Record<string, string> = {};
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = defined(argv[i], "argument");
  if (flagsWithValue.has(a)) {
    const value = argv[++i];
    if (value !== undefined) flags[a] = value;
  } else if (a === "--json" || a === "--headed" || a === "--no-navigate") flags[a] = "true";
  else rest.push(a);
}
const [command = "", ...args] = rest;
const session = flags["--session"] ?? "default";

const reply = (data: unknown) => console.log(JSON.stringify({ success: true, data, error: null }));
function fail(error: string): never {
  console.log(JSON.stringify({ success: false, data: null, error }));
  process.exit(1);
}

const script = read<Script>("script.json", {});
const state = read<Record<string, string>>("state.json", {});
const pageAt = (url: string): Page =>
  script.pages?.[url] ?? {
    title: "Fake page",
    snapshot: `- heading "Fake page for ${url}" [ref=e1]`,
  };

/** The engine action each implemented command runs, as the real engine names it in policy denials; undefined when the policy never sees it. */
function engineAction(): string | undefined {
  switch (command) {
    case "set":
      return args[0];
    case "open":
      return "navigate";
    case "get":
      return `get${args[0]}`;
    case "tab":
      return ["list", "new", "close"].includes(args[0] ?? "") ? `tab_${args[0]}` : "tab_switch";
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
  const policy = JSON.parse(readFileSync(flags["--action-policy"], "utf8")) as {
    default: "allow" | "deny";
    allow?: string[];
    deny?: string[];
  };
  if (policy.deny?.includes(action))
    fail(`Action '${action}' denied by policy: Action '${action}' is denied by policy`);
  if (policy.default === "deny" && !policy.allow?.includes(action))
    fail(`Action '${action}' denied by policy: Action '${action}' is not in the allow list`);
}
checkPolicy(engineAction());

/** `auth login` as the real engine does it: asks the credential plugin, refuses a page whose origin differs from the credential's with --no-navigate, fills, and reports success even when the site then shows another form. */
async function authLogin() {
  const [, name] = args;
  const provider = flags["--credential-provider"];
  const url = flags["--url"];
  const plugin = (
    JSON.parse(process.env.AGENT_BROWSER_PLUGINS ?? "[]") as {
      name: string;
      command: string;
      args?: string[];
    }[]
  ).find((p) => p.name === provider);
  if (!plugin || !url) fail("unknown credential provider");
  if (flags["--no-navigate"]) {
    const current = state[session];
    const here = current ? new URL(current).origin : "about:blank";
    if (here !== new URL(url).origin)
      fail(`Current page origin ${here} does not match credential origin ${new URL(url).origin}`);
  }
  checkPolicy(`plugin:${provider}:credential.read`);
  const child = Bun.spawn([plugin.command, ...(plugin.args ?? [])], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  await child.stdin.write(
    JSON.stringify({
      protocol: "agent-browser.plugin.v1",
      type: "credential.resolve",
      capability: "credential.read",
      request: { profileName: name, itemRef: flags["--item"], url },
    }),
  );
  await child.stdin.end();
  const answer = JSON.parse((await new Response(child.stdout).text()) || "{}") as {
    success?: boolean;
    credential?: { username: string; password: string };
  };
  if (!answer.success || !answer.credential) fail("credential provider failed");
  const expected = script.logins?.[url];
  if (expected?.error) fail(expected.error);
  if (
    expected &&
    answer.credential.username === expected.username &&
    answer.credential.password === expected.password
  ) {
    state[session] = expected.next;
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  }
  reply({ loggedIn: true, name });
}

const views = () => read<Record<string, number>>("views.json", {});
const setViews = (v: Record<string, number>) =>
  writeFileSync(join(dir, "views.json"), JSON.stringify(v));

/** The page as its `index`th `snapshot` call sees it: the page itself first, then each `later` entry in turn. */
function viewOf(url: string, index: number): Page {
  const page = pageAt(url);
  const next = page.later?.[Math.min(index, page.later.length) - 1];
  return next ? { ...page, ...next } : page;
}

await Bun.sleep(script.delayMs?.[command] ?? 0);
if (script.fail?.[command]) fail(script.fail[command]);

switch (command) {
  case "open": {
    const target = defined(args[0], "url");
    if (script.viaProxy && flags["--proxy"])
      await fetch(target, { proxy: flags["--proxy"] }).then((r) => r.arrayBuffer());
    const landed = script.redirects?.[target] ?? target;
    state[session] = landed;
    setViews({ ...views(), [session]: 0 });
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    reply({ title: pageAt(landed).title ?? "", url: landed });
    break;
  }
  case "snapshot": {
    const url = state[session];
    if (!url) fail("No page is open");
    const seen = views()[session] ?? 0;
    if (pageAt(url).later) setViews({ ...views(), [session]: seen + 1 });
    const page = viewOf(url, seen);
    const selector = args.includes("-s") ? args[args.indexOf("-s") + 1] : undefined;
    let snapshot = page.snapshot;
    if (selector) {
      const selected = page.selectors?.[selector];
      if (!selected) fail(`Selector '${selector}' did not match any element`);
      snapshot = selected;
    }
    if (args.includes("-i"))
      snapshot = snapshot
        .split("\n")
        .filter((l) => l.includes("[ref="))
        .join("\n");
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
  case "screenshot": {
    const path = defined(args[0], "screenshot path");
    writeFileSync(path, "png");
    reply({ path });
    break;
  }
  case "tab":
    reply({
      tabs: state[session]
        ? [
            {
              active: true,
              tabId: "t1",
              title:
                viewOf(defined(state[session], "url"), Math.max(0, (views()[session] ?? 0) - 1))
                  .title ?? "",
              type: "page",
              url: state[session],
            },
          ]
        : [],
    });
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
      setViews({ ...views(), [session]: 0 });
      writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    }
    reply({ done: command });
    break;
  }
  case "auth":
    if (args[0] !== "login") fail("Unknown auth command");
    await authLogin();
    break;
  case "set":
    if (args[0] !== "viewport") fail("Unknown set command");
    reply({ viewport: { width: Number(args[1]), height: Number(args[2]) } });
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
