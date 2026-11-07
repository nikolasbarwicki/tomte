import { fileURLToPath } from "node:url";

import { getBot } from "./bots/index.ts";
import { resolveCli } from "./harness/index.ts";
import { createHostServer } from "./host-server/index.ts";
import { acquireDataRootLock, DataRootLocked } from "./platform/data-root-lock.ts";
import { openDb } from "./platform/db.ts";
import {
  hostCommand,
  isCompiledHost,
  parseStartupConfig,
  serverCommand,
} from "./platform/launch.ts";
import { keychainSecrets } from "./platform/secrets.ts";
import { ensureWorkspace } from "./platform/workspace.ts";
import { directoryAssets, embeddedAssets, type UiAssets } from "./ui/index.ts";

const { config, positionals } = parseStartupConfig();
const [botArg] = positionals;

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

const cli = resolveCli(config.dataRoot);
if (!cli) {
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

const server = await createHostServer({
  config,
  cli,
  db: openDb(config.dataRoot),
  secrets: keychainSecrets,
  botId: botArg,
  ...(ui && { ui }),
}).catch((e: Error) => {
  console.error(e.message);
  lock.release();
  process.exit(2);
});
const opened = server.currentBotId() ? getBot(config.dataRoot, server.currentBotId()!) : undefined;
console.log(
  `claudebot UI: ${server.clientUrl}  workspace=${ensureWorkspace(config.dataRoot)}  data=${config.dataRoot}  bot=${opened ? `${opened.name} (${opened.id})` : "none"}`,
);
if (server.publicUrl !== server.clientUrl) console.log(`public URL: ${server.publicUrl}`);
console.log(
  `pair a browser: ${hostCommand("pair", "--data-root", config.dataRoot)}  (prints a code, valid once for 10 minutes; enter it at ${server.publicUrl})`,
);

const shutdown = async () => {
  const id = server.currentBotId();
  await server.close();
  lock.release();
  if (id) console.log(`reopen with: ${serverCommand(id)}`);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
