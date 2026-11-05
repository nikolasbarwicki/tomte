import { realpathSync } from "node:fs";
import { getBot } from "./bots.ts";
import { resolveCli } from "./cli.ts";
import { openDb } from "./db.ts";
import { keychainSecrets } from "./secrets.ts";
import { createHostServer } from "./host-server.ts";

const [cwdArg, botArg] = process.argv.slice(2);
const cli = resolveCli();
if (!cli && !process.env.ANTHROPIC_API_KEY) {
  console.error("refusing to start: no ANTHROPIC_API_KEY and no claude binary");
  process.exit(2);
}
if (!cli) {
  console.error("no claude binary resolved; set CLAUDE_PATH or run `bun src/host.ts install-cli`");
  process.exit(2);
}
const cwd = realpathSync(cwdArg ?? process.cwd());

const server = await createHostServer({
  cwd,
  port: Number(process.env.PORT ?? 5173),
  cli,
  db: openDb(cwd),
  secrets: keychainSecrets,
  botId: botArg,
  vite: true,
  herdr: true,
}).catch((e: Error) => {
  console.error(e.message);
  process.exit(2);
});
const opened = server.currentBotId() ? getBot(cwd, server.currentBotId()!) : undefined;
console.log(`claudebot UI: ${server.url}  cwd=${cwd}  bot=${opened ? `${opened.name} (${opened.id})` : "none"}`);

const shutdown = async () => {
  const id = server.currentBotId();
  await server.close();
  if (id) console.log(`reopen with: bun run ui ${cwd} ${id}`);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
