import { getBot } from "./bots/index.ts";
import { resolveCli } from "./harness/index.ts";
import { createHostServer } from "./host-server/index.ts";
import { InvalidConfig, parseHostConfig } from "./platform/config.ts";
import { acquireDataRootLock, DataRootLocked } from "./platform/data-root-lock.ts";
import { openDb } from "./platform/db.ts";
import { keychainSecrets } from "./platform/secrets.ts";
import { ensureWorkspace } from "./platform/workspace.ts";

const parsed = (() => {
  try {
    return parseHostConfig(process.argv.slice(2), process.env);
  } catch (e) {
    if (!(e instanceof InvalidConfig)) throw e;
    console.error(e.message);
    process.exit(2);
  }
})();
const { config } = parsed;
const [botArg] = parsed.positionals;
const cli = resolveCli(config.dataRoot);
if (!cli && !process.env.ANTHROPIC_API_KEY) {
  console.error("refusing to start: no ANTHROPIC_API_KEY and no claude binary");
  process.exit(2);
}
if (!cli) {
  console.error(
    "no claude binary resolved; set CLAUDE_PATH or run `bun packages/host/src/host.ts install-cli`",
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
}).catch((e: Error) => {
  console.error(e.message);
  lock.release();
  process.exit(2);
});
const opened = server.currentBotId() ? getBot(config.dataRoot, server.currentBotId()!) : undefined;
console.log(
  `claudebot UI: ${server.url}  workspace=${ensureWorkspace(config.dataRoot)}  data=${config.dataRoot}  bot=${opened ? `${opened.name} (${opened.id})` : "none"}`,
);
if (server.publicUrl !== server.url) console.log(`public URL: ${server.publicUrl}`);

const shutdown = async () => {
  const id = server.currentBotId();
  await server.close();
  lock.release();
  if (id) console.log(`reopen with: bun run ui ${id}`);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
