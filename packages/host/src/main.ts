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

if (HOST_SUBCOMMANDS.includes(parseStartupConfig().positionals[0] ?? "")) {
  await import("./host.ts");
} else {
  await import("./server.ts");
}
