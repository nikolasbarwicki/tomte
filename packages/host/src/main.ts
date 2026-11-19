// The compiled host's entry (`bun build --compile`), also runnable from source: `bun packages/host/src/main.ts [flags] [botId]`
// starts the host server like `server.ts`, and `main.ts <subcommand> …` runs the host subcommands of `host.ts`.
import { parseStartupConfig } from "./platform/launch.ts";

/** The `host.ts` subcommands the compiled host offers. The acceptance and chat commands of `host.ts` stay source-only. */
const HOST_SUBCOMMANDS = [
  "pair",
  "install-cli",
  "install-browser",
  "browser-smoke",
  "auth-status",
  "auth-login",
];

const command = process.argv[2];

if (command === "version") {
  // One JSON line: the root update helper runs this on the installed, the previous and the downloaded binary.
  const { VERSION } = await import("./harness/index.ts");
  const { SCHEMA_VERSION } = await import("./platform/db.ts");
  console.log(JSON.stringify({ version: VERSION, schemaVersion: SCHEMA_VERSION }));
} else if (command === "apply-update") {
  // Root only, started by tomte-update.service; it takes no flags (its settings are the root-owned /etc/tomte/update.conf).
  const { applyUpdate } = await import("./update-helper/index.ts");
  try {
    await applyUpdate({ uid: process.getuid?.() ?? -1 });
  } catch (e) {
    console.error(`apply-update: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (HOST_SUBCOMMANDS.includes(parseStartupConfig().positionals[0] ?? "")) {
  await import("./host.ts");
} else {
  await import("./server.ts");
}
