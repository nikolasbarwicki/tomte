import { fileURLToPath } from "node:url";

import { LaunchToken, SidecarReady } from "@tomte/contract/sidecar";

import { getBot } from "./bots/index.ts";
import {
  adoptClaudeConfigDir,
  installManagedCli,
  resolveCli,
  type ResolvedCli,
} from "./harness/index.ts";
import { createHostServer, type HostServer } from "./host-server/index.ts";
import { acquireDataRootLock, DataRootLocked } from "./platform/data-root-lock.ts";
import { openDb } from "./platform/db.ts";
import { openSecrets } from "./platform/file-secrets.ts";
import {
  hostCommand,
  isCompiledHost,
  parseStartupConfig,
  serverCommand,
} from "./platform/launch.ts";
import { readSidecarInput, type SidecarInput } from "./platform/sidecar-stdin.ts";
import { ensureWorkspace } from "./platform/workspace.ts";
import { directoryAssets, embeddedAssets, type UiAssets } from "./ui/index.ts";

const { config, positionals } = parseStartupConfig();
adoptClaudeConfigDir(config);
const [botArg] = positionals;

const sidecarInput = config.sidecar ? readSidecarInput(Bun.stdin.stream()) : undefined;

/** The sidecar protocol's first stdin line, which must be a launch token. Exits with code 2, never echoing the line, when it is not one. */
async function readLaunchToken(input: SidecarInput): Promise<string> {
  const line = await input.firstLine;
  if (line === undefined) {
    console.error("sidecar: stdin ended before a launch token line arrived");
    process.exit(2);
  }
  const token = LaunchToken.safeParse(line);
  if (!token.success) {
    console.error(
      "sidecar: the first stdin line is not a launch token (expected 43 base64url characters)",
    );
    process.exit(2);
  }
  return token.data;
}
const launchToken = sidecarInput ? await readLaunchToken(sidecarInput) : undefined;

/** The built web UI to serve: embedded in the compiled host, else the web package's build output; none when Vite serves it. Exits when the UI is not there. */
async function uiAssets(): Promise<UiAssets | undefined> {
  const compiled = isCompiledHost();
  if (config.vite) {
    if (!compiled) return undefined;
    console.error(
      "--vite needs the web package source and Vite, which the compiled host does not include; run the source with `bun run dev`",
    );
    process.exit(2);
  }
  const webBuild = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const assets = compiled ? embeddedAssets() : directoryAssets(webBuild);
  if (!(await assets.read("/index.html"))) {
    console.error(
      compiled
        ? "this host binary was built without the web UI; rebuild it with `bun run build:host`"
        : `no web UI build at ${webBuild}; run \`bun run build:web\` first, or start with \`--vite\` (\`bun run dev\`) to serve the UI through Vite`,
    );
    process.exit(2);
  }
  return assets;
}
const ui = await uiAssets();

const resolved = resolveCli(config.dataRoot);
if (!resolved && !config.sidecar) {
  console.error(
    `refusing to start: no claude binary resolved (CLAUDE_PATH, managed copy, PATH); set CLAUDE_PATH or run \`${hostCommand("install-cli", "--data-root", config.dataRoot)}\``,
  );
  process.exit(2);
}
const lock = (() => {
  try {
    return acquireDataRootLock(config.dataRoot);
  } catch (e) {
    if (!(e instanceof DataRootLocked)) throw e;
    console.error(e.message);
    process.exit(2);
  }
})();

let server: HostServer | undefined;
let stopping: Promise<never> | undefined;
/** The same graceful stop for SIGINT, SIGTERM and the end of a sidecar's stdin; a second request waits on the first. */
const shutdown = () =>
  (stopping ??= (async () => {
    const id = server?.currentBotId();
    await server?.close();
    lock.release();
    if (id && !config.sidecar) console.log(`reopen with: ${serverCommand(id)}`);
    process.exit(0);
  })());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
void sidecarInput?.ended.then(shutdown);

/** The desktop app's first launch has no terminal to run `install-cli` in, so a sidecar installs the managed Claude CLI itself. */
async function installSidecarCli(): Promise<ResolvedCli> {
  console.error(`no claude binary resolved; installing the managed copy into ${config.dataRoot}`);
  try {
    console.error(`installed ${await installManagedCli(config.dataRoot)}`);
    const installed = resolveCli(config.dataRoot);
    if (installed) return installed;
    console.error("the installed claude binary did not resolve");
  } catch (e) {
    console.error(`could not install the managed claude binary: ${(e as Error).message}`);
  }
  lock.release();
  process.exit(2);
}
const cli = resolved ?? (await installSidecarCli());

server = await (async () => {
  const secrets = openSecrets(config);
  return createHostServer({
    config,
    cli,
    db: await openDb(config.dataRoot, secrets),
    secrets,
    botId: botArg,
    ...(ui && { ui }),
  });
})().catch((e: Error) => {
  console.error(e.message);
  lock.release();
  process.exit(2);
});
if (launchToken) server.devices.registerLaunchDevice(launchToken);
const opened = server.currentBotId() ? getBot(config.dataRoot, server.currentBotId()!) : undefined;
/** In sidecar mode stdout carries the ready line and nothing else. */
const say = config.sidecar ? console.error : console.log;
say(
  `tomte UI: ${server.clientUrl}  workspace=${ensureWorkspace(config.dataRoot)}  data=${config.dataRoot}  bot=${opened ? `${opened.name} (${opened.id})` : "none"}`,
);
if (server.publicUrl !== server.clientUrl) say(`public URL: ${server.publicUrl}`);
say(
  `pair a browser: ${hostCommand("pair", "--data-root", config.dataRoot)}  (prints a code, valid once for 10 minutes; enter it at ${server.publicUrl})`,
);
if (config.sidecar)
  process.stdout.write(
    `${JSON.stringify(SidecarReady.parse({ type: "ready", clientUrl: server.clientUrl }))}\n`,
  );
