// Smoke test for a compiled host binary on this machine (the build script's output, run for real):
//   bun scripts/smoke-host.ts [dist/host/claudebot-host-darwin-arm64]   (default: this machine's build output)
// Copies the binary to a temporary directory outside the repo and runs it from there on a temporary data root and a
// free port. Installs the managed Claude CLI with `install-cli` (first use) unless CLAUDE_PATH names one, starts the
// host, pairs a device with the `pair` subcommand, creates a bot the way the UI does, checks the event stream, loads
// the UI from the embedded assets (every script and stylesheet index.html references, with the CSP), checks what the
// client listener must refuse, stops the host with SIGTERM and removes the temporary directory.
// Never prints the pairing code or the device token. Exits non-zero on the first failed check.
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const fail = (message: string): never => {
  throw new Error(`smoke failed: ${message}`);
};
const check = (ok: boolean, message: string) => {
  if (!ok) fail(message);
  console.log(`  ok: ${message}`);
};

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  return port ?? fail("no free port");
}

/** The host server process: its stdout is piped for the startup line, its stderr is ours. */
type HostProcess = Bun.Subprocess<"ignore", "pipe", "inherit">;

function startHost(
  binary: string,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): HostProcess {
  return Bun.spawn([binary, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
}

/** The client URL from the host's startup line. The rest of its stdout keeps draining so the host never blocks on a full pipe. */
function clientUrl(server: HostProcess): Promise<string> {
  const url = Promise.withResolvers<string>();
  const decoder = new TextDecoder();
  let seen = "";
  void (async () => {
    for await (const chunk of server.stdout) {
      seen += decoder.decode(chunk);
      const found = /claudebot UI: (http:\/\/\S+)/.exec(seen)?.[1];
      if (found) url.resolve(found);
    }
    url.reject(new Error(`the host exited before reporting its URL; stdout: ${seen}`));
  })();
  const timer = setTimeout(
    () =>
      url.reject(
        new Error(
          `the host did not report its URL within ${STARTUP_TIMEOUT_MS / 1000}s; stdout so far: ${seen}`,
        ),
      ),
    STARTUP_TIMEOUT_MS,
  );
  return url.promise.finally(() => clearTimeout(timer));
}

async function run(
  binary: string,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  stdin?: string,
) {
  const child = Bun.spawn([binary, ...args], {
    cwd,
    env,
    stdin: stdin === undefined ? "ignore" : new Response(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

/** `<script src>` and `<link rel=stylesheet|modulepreload href>` targets of an HTML page. */
function referencedAssets(html: string): string[] {
  const refs = new Set<string>();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const isLink = tag.startsWith("<link");
    if (isLink && !/\brel="(?:stylesheet|modulepreload)"/.test(tag)) continue;
    const ref = new RegExp(`\\b${isLink ? "href" : "src"}="([^"]+)"`).exec(tag)?.[1];
    if (ref) refs.add(ref);
  }
  return [...refs];
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
};

/** The `bots` event of the `/api/events` snapshot, read from the stream's first events. */
async function snapshotBots(base: string, headers: Record<string, string>): Promise<string[]> {
  const res = await fetch(`${base}/api/events`, { headers, signal: AbortSignal.timeout(10_000) });
  check(res.status === 200, "/api/events answers 200 with a token");
  const reader = res.body?.getReader() ?? fail("/api/events has no body");
  const decoder = new TextDecoder();
  let seen = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return fail("/api/events closed before a bots event");
      seen += decoder.decode(value, { stream: true });
      for (const line of seen.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6)) as { type: string; bots?: { id: string }[] };
        if (event.type === "bots") return (event.bots ?? []).map((b) => b.id);
      }
    }
  } finally {
    await reader.cancel();
  }
}

async function main(): Promise<number> {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const os = process.platform === "win32" ? "windows" : process.platform;
  const source =
    positionals[0] ??
    join(
      import.meta.dir,
      "..",
      "dist/host",
      `claudebot-host-${os}-${process.arch}${os === "windows" ? ".exe" : ""}`,
    );
  if (!existsSync(source)) {
    console.error(
      `no host binary at ${source}; run \`bun run build:host\` or pass the binary: bun scripts/smoke-host.ts <host binary>`,
    );
    return 2;
  }

  const root = await mkdtemp(join(tmpdir(), "claudebot-host-smoke-"));
  const binary = join(
    root,
    "bin",
    source.endsWith(".exe") ? "claudebot-host.exe" : "claudebot-host",
  );
  await mkdir(join(root, "bin"));
  await copyFile(source, binary);
  await chmod(binary, 0o755);
  const env: Record<string, string | undefined> = { ...process.env };
  const dataRoot = join(root, "data");
  const flags = ["--data-root", dataRoot];
  console.log(`binary copied to ${binary}; running from ${root}, not from the repo`);
  console.log(`temporary data root ${dataRoot}`);

  try {
    console.log("a Claude CLI for the host");
    if (env.CLAUDE_PATH) {
      console.log(`  using CLAUDE_PATH=${env.CLAUDE_PATH} (no managed install)`);
    } else {
      const installed = await run(binary, ["install-cli", ...flags], env, root);
      console.log(`  ${installed.stdout.trim()}`);
      check(installed.code === 0, "`install-cli` installed the managed Claude CLI (first use)");
    }

    const port = await freePort();
    const server = startHost(binary, [...flags, "--port", String(port)], env, root);
    try {
      const base = await clientUrl(server);
      console.log(`host started at ${base}`);
      check((await fetch(`${base}/`)).status === 200, "the host answers");

      console.log("the UI, from the assets embedded in the binary");
      const csp = (res: Response, what: string) =>
        check(
          res.headers.get("content-security-policy")?.includes("frame-ancestors 'none'") === true,
          `${what} carries a CSP with frame-ancestors 'none'`,
        );
      const page = await fetch(`${base}/`);
      const html = await page.text();
      check(page.status === 200, "GET / answers 200");
      check(page.headers.get("content-type")?.startsWith("text/html") === true, "as text/html");
      check(html.includes('id="root"'), "with the app's index.html");
      csp(page, "GET /");
      const deep = await fetch(`${base}/bots/abc?panel=files`);
      check(deep.status === 200, "a deep link answers 200");
      check(
        deep.headers.get("content-type")?.startsWith("text/html") === true &&
          (await deep.text()) === html,
        "with the same index.html",
      );
      csp(deep, "the deep link");
      const assets = referencedAssets(html);
      check(
        assets.some((a) => a.endsWith(".js")) && assets.some((a) => a.endsWith(".css")),
        `index.html references ${assets.length} assets, scripts and stylesheets among them`,
      );
      for (const ref of assets) {
        const asset = await fetch(new URL(ref, `${base}/`));
        const type = CONTENT_TYPES[extname(ref)] ?? fail(`unexpected asset type ${ref}`);
        const problems = [
          asset.status !== 200 && `status ${asset.status}`,
          asset.headers.get("content-type")?.startsWith(type) !== true && "content type",
          (await asset.text()).length === 0 && "empty body",
          asset.headers.get("content-security-policy")?.includes("frame-ancestors 'none'") !==
            true && "CSP",
        ].filter(Boolean);
        check(
          problems.length === 0,
          problems.length === 0
            ? `${ref}: 200, ${type}, a body, CSP with frame-ancestors 'none'`
            : `${ref}: ${problems.join(", ")}`,
        );
      }
      check((await fetch(`${base}/assets/nope.js`)).status === 404, "a missing asset answers 404");

      console.log("pairing, a bot and the event stream");
      const paired = await run(binary, ["pair", ...flags], env, root);
      const code = paired.stdout.trim();
      check(paired.code === 0 && code.length > 0, "`pair` printed a code (not shown)");
      const exchange = (body: object) =>
        fetch(`${base}/api/pair`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: base },
          body: JSON.stringify(body),
        });
      const exchanged = await exchange({ code, name: "smoke" });
      check(exchanged.status === 200, "the code pairs a device at POST /api/pair");
      const { token } = (await exchanged.json()) as { token: string };
      check((await exchange({ code, name: "again" })).status !== 200, "the code works once");
      const auth = {
        authorization: `Bearer ${token}`,
        origin: base,
        "content-type": "application/json",
      };
      const info = (await (await fetch(`${base}/api/info`, { headers: auth })).json()) as {
        cli: string;
        browser: { status: string; source?: string };
      };
      console.log(
        `  info: cli=${info.cli.replace(root, "<tmp>")} browser=${info.browser.status}/${info.browser.source ?? "-"}`,
      );
      const created = await fetch(`${base}/api/bots/new`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "Smoke", purpose: "", face: "tuft", stroke: "ink" }),
      });
      const bot = (await created.json()) as { id?: string; name?: string };
      check(created.status === 200 && bot.name === "Smoke", `a bot is created (${bot.id})`);
      check(
        (await snapshotBots(base, auth)).includes(bot.id ?? ""),
        "the /api/events snapshot lists the bot",
      );

      console.log("what must be refused");
      check(
        (await fetch(`${base}/api/events`)).status === 401,
        "/api/events without a token answers 401",
      );
      for (const path of ["/mcp/browser", "/mcp/bots", "/api/browser/credential-exchange"]) {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { ...auth, accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        check(
          res.status === 404,
          `the agent listener path ${path} answers 404 on the client listener`,
        );
      }

      console.log("the credential plugin subcommand");
      const plugin = await run(
        binary,
        ["credential-plugin", "http://127.0.0.1:9"],
        env,
        root,
        JSON.stringify({ protocol: "agent-browser.plugin.v1", type: "plugin.manifest" }),
      );
      check(
        plugin.stdout.includes('"name":"claudebot"') && plugin.code === 0,
        "answers the plugin manifest request",
      );

      console.log("the dev flag");
      const vite = await run(binary, [...flags, "--vite"], env, root);
      check(
        vite.code === 2 && vite.stderr.includes("--vite"),
        "`--vite` is refused with a message",
      );

      console.log("shutdown");
      server.kill("SIGTERM");
      const force = setTimeout(() => server.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
      const exit = await server.exited;
      clearTimeout(force);
      check(exit === 0, "SIGTERM stops the host with exit 0");
      check(!existsSync(join(dataRoot, "host.lock")), "the data root lock is released");
    } finally {
      if (server.exitCode === null) {
        server.kill("SIGKILL");
        await server.exited;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("temporary directory removed");
  console.log("\nsmoke-host: ok");
  return 0;
}

process.exitCode = await main().catch((e: Error) => {
  console.error(e.message);
  return 1;
});
