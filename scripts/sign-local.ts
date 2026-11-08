// The local macOS signing route: signs and notarizes an arm64 build on this Mac for personal testing, from a certificate
// and an App Store Connect API key you hold. Guide, prerequisites and the list of what is verified: docs/release/local-signing.md.
//   bun scripts/sign-local.ts plan    --out <new folder> [--version <semver>] [--add-to-search-list]
//       prints every operation in order with redacted arguments, all paths, the identity rule and the global settings
//       touched. Runs nothing and reads no file. This is the default command.
//   bun scripts/sign-local.ts run     --out <new folder> [--version <semver>] [--add-to-search-list] --confirm-keychain-and-notary-upload
//       creates a temporary keychain inside <out>, imports the certificate, signs, notarizes (uploads to Apple), staples
//       and verifies. Refuses in CI. Credentials come only from the CLAUDEBOT_LOCAL_* environment variables (local-signing-kit.ts).
//   bun scripts/sign-local.ts cleanup --out <folder>
//       finishes the cleanup of a run that was killed hard: deletes its temporary keychain and signing folder.
// `--arch arm64` is the only accepted architecture (and the default).
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { VERSION as HOST_VERSION } from "../packages/host/src/harness/claude-access.ts";
import { spawnRunner, stopRunningCommands } from "./command-runner.ts";
import { inCi } from "./desktop-kit.ts";
import {
  LOCAL_ENV,
  placeholderSecrets,
  readLocalInputs,
  resolveLocalConfig,
  UsageError,
} from "./local-signing-kit.ts";
import {
  cleanupLocal,
  type Deps,
  loadSecrets,
  renderPlan,
  runLocalSigning,
} from "./local-signing.ts";
import { outsideLineage, processes } from "./process-guard.ts";

const USAGE =
  "usage: bun scripts/sign-local.ts [plan|run|cleanup] --out <folder> [--version <semver>] [--arch arm64] [--add-to-search-list] [--confirm-keychain-and-notary-upload]";

const deps: Deps = {
  run: spawnRunner,
  log: (line) => console.log(line),
  warn: (line) => console.warn(`warning: ${line}`),
  // This script's own command line names --out.
  processes: () => outsideLineage(processes(), process.pid),
  onSignal: (handler) => {
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    return () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    };
  },
  stopCommands: stopRunningCommands,
  exit: (code) => process.exit(code),
};

async function main(): Promise<number> {
  const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      version: { type: "string" },
      arch: { type: "string", multiple: true },
      "add-to-search-list": { type: "boolean" },
      "confirm-keychain-and-notary-upload": { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "plan";
  if (positionals.length > 1 || !["plan", "run", "cleanup"].includes(command)) {
    console.error(USAGE);
    return 2;
  }
  const inputs = readLocalInputs(process.env);
  // Read once; children (build, electron-builder, notarytool) never inherit the credentials' names or values.
  for (const name of Object.values(LOCAL_ENV)) delete process.env[name];

  if (command === "cleanup") {
    if (inCi(process.env)) throw new Error("the local signing route never runs in CI");
    if (flags.out === undefined) throw new UsageError("--out <folder> is required");
    await cleanupLocal(resolve(flags.out), deps);
    return 0;
  }

  const draft = resolveLocalConfig({
    flags: {
      out: flags.out,
      version: flags.version,
      arch: flags.arch ?? [],
      confirm: flags["confirm-keychain-and-notary-upload"] ?? false,
      addToSearchList: flags["add-to-search-list"] ?? false,
    },
    inputs,
    platform: process.platform,
    ci: inCi(process.env),
    repoRoot: new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
    hostVersion: HOST_VERSION,
    runId: command === "plan" ? "<run-id>" : crypto.randomUUID().replaceAll("-", ""),
    secrets: placeholderSecrets(),
  });
  if (command === "plan") {
    process.stdout.write(renderPlan(draft));
    return 0;
  }
  const secrets =
    draft.problems.length === 0
      ? await loadSecrets(inputs, inputs.apiKeyId as string, inputs.apiIssuer as string)
      : draft.secrets;
  await runLocalSigning({ ...draft, secrets }, deps);
  return 0;
}

process.exitCode = await main().catch((error: Error) => {
  console.error(error.message);
  return error instanceof UsageError ? 2 : 1;
});
