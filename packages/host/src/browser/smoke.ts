import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { HostEvent, type ServerEvent } from "@tomte/contract/events";
import type { Server } from "bun";

import { createBot } from "../bots/index.ts";
import { resolveCli } from "../harness/index.ts";
import { createHostServer, type HostServer } from "../host-server/index.ts";
import type { HostConfig } from "../platform/config.ts";
import { migrate } from "../platform/db.ts";
import { memorySecrets } from "../platform/secrets.ts";
import { ensureWorkspace } from "../platform/workspace.ts";
import { engineStatus } from "./engine.ts";

/**
 * Real-engine smoke: the real host server, egress proxy, agent-browser engine, Chrome for Testing and Claude CLI,
 * driven through the UI routes. Needs the engine installed (the `install-browser` host subcommand) and a working Claude login.
 */

const log = (l: string) => console.error(l);
const step = (l: string) => console.log(`\n== ${l}`);
const fail = (m: string): never => {
  throw new Error(`smoke failed: ${m}`);
};
const check = (ok: boolean, m: string) => {
  if (!ok) fail(m);
  console.log(`  ok: ${m}`);
};

/** The egress proxy blocks loopback, so the test site has to be reachable on this machine's LAN address. */
function lanIp(): string | undefined {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
  return undefined;
}

/** Plain-http test site: a form and a page that needs a human. Records what it receives. */
interface Site {
  server: Server<undefined>;
  seen: { formName: string | undefined; captchaViews: number };
  base: string;
}

function processes(): Set<string> {
  const out = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout;
  const mine = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /agent-browser|Chrome for Testing/.test(l) && !/browser-smoke|ps -axo/.test(l));
  return new Set(mine);
}

export async function runBrowserSmoke(config: HostConfig) {
  const status = engineStatus(config.dataRoot);
  if (status.status === "unavailable") {
    console.log(`browser-smoke: skipped (${status.reason})`);
    return;
  }
  const cli = resolveCli(config.dataRoot);
  if (!cli) {
    console.log("browser-smoke: skipped (no claude binary resolved)");
    return;
  }
  const ip = lanIp();
  if (!ip) {
    console.log("browser-smoke: skipped (no LAN IPv4 address for the test site)");
    return;
  }

  const before = processes();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tomte-browser-smoke-")));
  const dataRoot = join(root, ".host");
  const workspace = ensureWorkspace(dataRoot);
  log(
    `[smoke] data root=${dataRoot} workspace=${workspace} engine=${status.path} site=http://${ip}`,
  );

  const site = startSite(ip);
  const secrets = memorySecrets();
  const db = migrate(new Database(":memory:"));
  const bot = createBot(dataRoot, "smoke", "Browser smoke test");
  // The smoke's state lives in a throwaway data root, so the engine installed in the configured one is pointed at directly.
  process.env.AGENT_BROWSER_PATH = status.path;
  const server = await createHostServer({
    config: { ...config, dataRoot },
    cli,
    db,
    secrets,
    botId: bot.id,
  });

  try {
    await scenarios(server, site, bot.id, workspace);
  } finally {
    await site.server.stop(true);
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }

  step("no engine or Chrome for Testing process survives host shutdown");
  await Bun.sleep(1500);
  const leaked = [...processes()].filter((p) => !before.has(p));
  check(
    leaked.length === 0,
    `no leftover agent-browser/Chrome for Testing processes${leaked.length ? `: ${leaked.join(" | ")}` : ""}`,
  );
  console.log("\nbrowser-smoke: ok");
}

function startSite(host: string): Site {
  const seen = {
    formName: undefined as string | undefined,
    captchaViews: 0,
  };
  const page = (title: string, body: string) =>
    new Response(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`, {
      headers: { "content-type": "text/html" },
    });
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/form" && req.method === "POST") {
        const who = (await req.formData()).get("who");
        seen.formName = typeof who === "string" ? who : "";
        return page("Message sent", `<p>Thanks, ${seen.formName.replace(/[<>&]/g, "")}.</p>`);
      }
      if (pathname === "/form")
        return page(
          "Contact form",
          `<form method="post" action="/form"><label>Your name <input name="who" type="text"></label><button type="submit">Send message</button></form>`,
        );
      if (pathname === "/captcha") {
        seen.captchaViews++;
        return page("Verify you are human", `<p>This step needs a person to solve a puzzle.</p>`);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, seen, base: `http://${host}:${server.port}` };
}

async function scenarios(server: HostServer, site: Site, botId: string, workspace: string) {
  const paired =
    server.devices.pair(server.devices.createPairingCode(), "browser smoke") ??
    fail("could not pair a device with the smoke host");
  const auth = { authorization: `Bearer ${paired.token}` };
  const ui = (path: string, body: object) =>
    fetch(`${server.clientUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.clientUrl, ...auth },
      body: JSON.stringify(body),
    });

  const received: HostEvent[] = [];
  const abort = new AbortController();
  void (async () => {
    const res = await fetch(`${server.clientUrl}/api/events`, {
      headers: auth,
      signal: abort.signal,
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      const parts = (buffer + value).split("\n\n");
      buffer = parts.pop() ?? "";
      for (const p of parts) received.push(HostEvent.parse(JSON.parse(p.replace(/^data: /, ""))));
    }
  })();

  const until = async (what: string, cond: () => boolean, ms = 240_000) => {
    const t = Date.now();
    while (!cond()) {
      if (Date.now() - t > ms) fail(`timed out waiting for ${what}`);
      const err = received.find((e) => e.type === "error") as
        | Extract<ServerEvent, { type: "error" }>
        | undefined;
      if (err) fail(`chat error while waiting for ${what}: ${err.message}`);
      await Bun.sleep(100);
    }
  };
  const doneCount = () => received.filter((e) => e.type === "done").length;
  const tools = () =>
    received.filter((e) => e.type === "tool").map((e) => (e as { name: string }).name);

  /** Sends a user message and waits for that turn to finish; returns the tools it used. */
  const turn = async (prompt: string) => {
    const n = doneCount();
    const t0 = tools().length;
    const r = await ui("/api/send", { text: prompt });
    if (r.status !== 200) fail(`/api/send answered ${r.status}`);
    await until("the turn to finish", () => doneCount() > n);
    return tools().slice(t0);
  };

  step("enable the browser for the bot");
  check(
    (await ui("/api/bots/browser", { botId, enabled: true })).status === 200,
    "POST /api/bots/browser enabled:true",
  );
  check((await ui("/api/open", { botId })).status === 200, "bot opened");

  step("(a) open a local page, fill and submit a form");
  const toolsA = await turn(
    `Use your browser tools (mcp__browser__*). Open ${site.base}/form, type "Ada Lovelace" into the "Your name" field, click "Send message", and then tell me the page heading you end up on.`,
  );
  console.log(`  tools: ${toolsA.join(", ")}`);
  check(
    toolsA.some((t) => t === "mcp__browser__browser_open"),
    "the bot used browser_open",
  );
  check(
    site.seen.formName === "Ada Lovelace",
    `the server received the submitted form (who=${JSON.stringify(site.seen.formName)})`,
  );

  step("(b) browser_request_takeover");
  const cards1 = received.filter((e) => e.type === "wait").length;
  const toolsC = await turn(
    `Open ${site.base}/captcha. That page needs a human, so call browser_request_takeover with a one-sentence reason and end your turn. When the user answers, tell me what they said.`,
  );
  console.log(`  tools: ${toolsC.join(", ")}`);
  const tcard = received.filter((e) => e.type === "wait").slice(cards1)[0] as
    | Extract<ServerEvent, { type: "wait" }>
    | undefined;
  check(
    !!tcard && tcard.kind === "takeover",
    `takeover card appears (${tcard?.title}: ${tcard?.detail})`,
  );
  check(
    tcard!.actions.map((a) => a.label).join("/") === "I'm done/Skip",
    "card offers I'm done/Skip",
  );
  const m = doneCount();
  check(
    (await ui("/api/waits/answer", { id: tcard!.id, action: "skip" })).status === 200,
    "answered Skip through /api/waits/answer",
  );
  await until("the resumed takeover turn to finish", () => doneCount() > m);
  const transcript = JSON.stringify(await getSessionMessages(botId, { dir: workspace }));
  check(
    transcript.includes(`<human-wait-result id=\\"${tcard!.id}\\">`) &&
      transcript.includes("The user skipped the takeover"),
    "the bot received the Skip resume message",
  );

  step("sandbox: the bot's shell cannot reach engine state or the browser endpoint");
  const endpoint = server.browser.lease(botId).servers[0]?.url;
  if (!endpoint) throw new Error("the lease has no browser endpoint");
  const before = (await getSessionMessages(botId, { dir: workspace })).length;
  await turn(
    `Run these four shell commands with your Bash tool, each as its own call, exactly as written, and do not retry or work around failures:\n` +
      `1. ls -la ~/.agent-browser 2>&1; echo "exit=$?"\n` +
      `2. cat ~/.agent-browser/config.json 2>&1; echo "exit=$?"\n` +
      `3. curl -sS -m 5 -o /dev/null -w "http=%{http_code}" ${endpoint} 2>&1; echo " exit=$?"\n` +
      `4. python3 -c "import os; print(os.listdir(os.path.expanduser('~/.agent-browser')))" 2>&1\n` +
      `Then reply with the four outputs.`,
  );
  const results = (await getSessionMessages(botId, { dir: workspace }))
    .slice(before)
    .filter((x) => x.type === "user")
    .map((x) => JSON.stringify(x.message));
  const outputs = results.filter((r) => r.includes("tool_result"));
  check(outputs.length >= 4, `the bot ran four Bash commands (${outputs.length} results)`);
  const [ls = "", cat = "", curl = "", py = ""] = outputs;
  for (const o of outputs) console.log(`  bash result: ${o.slice(0, 400)}`);
  check(
    /denied|Operation not permitted|exit=[1-9]/.test(ls) && !/sessions|browsers|\.key/.test(ls),
    "ls ~/.agent-browser was denied and listed nothing",
  );
  check(
    /denied|Operation not permitted|No such file|exit=[1-9]/.test(cat),
    "cat ~/.agent-browser/config.json was denied",
  );
  check(
    /PermissionError|Operation not permitted|denied/.test(py) && !/sessions|browsers/.test(py),
    "a python listing of ~/.agent-browser was denied (sandbox layer)",
  );
  check(
    !/http=200/.test(curl) && /exit=[1-9]|http=000/.test(curl),
    "curl to the browser endpoint failed from the sandbox",
  );

  step("sign out and shut down");
  await ui("/api/bots/browser/sign-out", { botId });
  abort.abort();
}
