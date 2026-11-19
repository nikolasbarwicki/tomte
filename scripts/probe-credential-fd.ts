// Can a bot's Bash read the credential the host gives the Claude CLI? (client/host split, ticket 15; runbook: docs/probe-credential-fd.md)
//   bun scripts/probe-credential-fd.ts host-env  --data-root <dir> --host <tomte-host binary> [--auth bearer|api_key]
//   bun scripts/probe-credential-fd.ts fd-oauth   --data-root <dir> [--fd-kind pipe|file] [--sandbox on|off] [--env NAME=VALUE]...
//   bun scripts/probe-credential-fd.ts fd-gateway --data-root <dir> [--fd-kind pipe|file] [--sandbox on|off] [--env NAME=VALUE]...
//   bun scripts/probe-credential-fd.ts env-token  --data-root <dir> [--sandbox on|off] [--env NAME=VALUE]...
// Linux only (remote mode and the bwrap sandbox). `<dir>` holds the managed CLI (`tomte-host install-cli --data-root <dir>`).
// No sign-in and no Anthropic traffic: a fake Anthropic Messages API on loopback answers the CLI's first request with a
// `tool_use` of Bash running scripts/probe-credential-fd.sh, and records the `tool_result` of the next one. The token is
// a canary (`canary-<32 hex>`) generated per run; nothing real is ever read or printed.
//   host-env:   the real host runs in remote mode, the canary is stored as the custom provider's token through
//               /api/providers/claude/gateway (the host hands it to the CLI on a descriptor, not in the environment),
//               a bot is created and sent one message: the host's own spawn path, sandbox and settings.
//   fd-*:       the canary goes to the CLI on an extra inherited descriptor (fd 3) named by
//               CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR or CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR. The host does this itself now
//               (`host-env`); these modes isolate the mechanism. The probe opens the CLI through the SDK with the host's environment
//               (`createClaudeAccess`) and launch options
//               (`claudeHarness`, `browserIsolation`) and a spawn function that adds the descriptor. `--fd-kind pipe` (default) is a
//               pipe written once and closed; `file` is an unlinked file the CLI reads from offset 0 (a bot that can reopen it
//               through /proc gets the bytes again, the worst case).
// The run only counts when the fake gateway received the canary as the CLI's own auth header: otherwise the CLI never
// read it and "not visible" would prove nothing. Prints one report in a stable format; exit 0 when the canary was not
// visible to the shell, 3 when it was, 1 when the probe itself failed, 2 on bad usage.
//   env-token:  the canary in ANTHROPIC_AUTH_TOKEN in the CLI's own environment, as the host did before it used descriptors, without the host.
//               `--sandbox off` runs the shell unsandboxed: the positive control that proves the scan can find a canary (exit 0
//               only when it IS found, 1 when the scan is blind). `--env NAME=VALUE` adds a variable to the CLI's environment.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { query, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { browserIsolation } from "../packages/host/src/browser/sandbox.ts";
import { createClaudeAccess } from "../packages/host/src/harness/claude-access.ts";
import { resolveCli, type ResolvedCli } from "../packages/host/src/harness/cli.ts";
import { claudeHarness } from "../packages/host/src/harness/index.ts";
import { parseHostConfig } from "../packages/host/src/platform/config.ts";
import probeShell from "./probe-credential-fd.sh" with { type: "text" };

const MODES = ["host-env", "fd-oauth", "fd-gateway", "env-token"] as const;
type Mode = (typeof MODES)[number];

const FD_VARIABLE: Record<"fd-oauth" | "fd-gateway", string> = {
  "fd-oauth": "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "fd-gateway": "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
} as const;

/** The descriptor number the CLI is told to read; the spawn function puts the credential there. */
const CREDENTIAL_FD = 3;

const STARTUP_TIMEOUT_MS = 30_000;

/** `PROBE_DEBUG=1` follows the fake gateway and the CLI's stderr live; never use it with a real credential. */
const DEBUG = process.env.PROBE_DEBUG === "1";

class ProbeFailed extends Error {}
const fail = (message: string): never => {
  throw new ProbeFailed(message);
};

/** What the fake gateway learned. `toolResult` is the text the CLI sent back after running the probe's Bash command. */
interface GatewayRecord {
  messageRequests: number;
  /** How the canary arrived as the CLI's own auth header, if it did. */
  canaryArrivedAs: "authorization: Bearer" | "x-api-key" | undefined;
  /** Requests whose auth header was not the canary (only counted, never shown). */
  otherAuth: number;
  paths: Set<string>;
}

interface Gateway {
  url: string;
  record: GatewayRecord;
  toolResult: Promise<string>;
  stop(): void;
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: "Bash"; input: { command: string; description: string } };

const toolUse = (command: string): Block => ({
  type: "tool_use",
  id: "toolu_probe",
  name: "Bash",
  input: { command, description: "probe" },
});

/** A Messages API response as the event stream the CLI asks for. */
function sse(block: Block, stopReason: string): Response {
  const event = (name: string, data: object) =>
    `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
  const start = block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" };
  const delta =
    block.type === "tool_use"
      ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : { type: "text_delta", text: block.text };
  const body = [
    event("message_start", {
      message: {
        id: "msg_probe",
        type: "message",
        role: "assistant",
        content: [],
        model: "probe",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    event("content_block_start", { index: 0, content_block: start }),
    event("content_block_delta", { index: 0, delta }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    event("message_stop", {}),
  ].join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const ToolResult = z.object({
  type: z.literal("tool_result"),
  content: z
    .union([z.string(), z.array(z.looseObject({ text: z.string().optional() }))])
    .optional(),
});

const MessagesBody = z.looseObject({
  stream: z.boolean().optional(),
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
  messages: z.array(z.looseObject({ content: z.unknown() })).optional(),
});
type MessagesBody = z.infer<typeof MessagesBody>;

/** The text of the `tool_result` block that ends the conversation, if the last message has one. */
function toolResultOf(body: MessagesBody): string | undefined {
  const content = body.messages?.at(-1)?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const result = ToolResult.safeParse(block);
    if (!result.success) continue;
    const parts = result.data.content ?? "";
    return typeof parts === "string" ? parts : parts.map((p) => p.text ?? "").join("\n");
  }
  return undefined;
}

function startGateway(canary: string): Gateway {
  const record: GatewayRecord = {
    messageRequests: 0,
    canaryArrivedAs: undefined,
    otherAuth: 0,
    paths: new Set(),
  };
  const result = Promise.withResolvers<string>();
  let issued = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      record.paths.add(`${req.method} ${pathname}`);
      if (DEBUG) console.error(`[gateway] ${req.method} ${pathname}`);
      const bearer = req.headers.get("authorization");
      const apiKey = req.headers.get("x-api-key");
      if (bearer === `Bearer ${canary}`) record.canaryArrivedAs ??= "authorization: Bearer";
      else if (apiKey === canary) record.canaryArrivedAs ??= "x-api-key";
      else if (bearer || apiKey) record.otherAuth++;
      if (req.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
      if (pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 1 });
      if (!pathname.endsWith("/v1/messages"))
        return Response.json({ error: "not found" }, { status: 404 });
      record.messageRequests++;
      const body = MessagesBody.parse(await req.json());
      const finished = toolResultOf(body);
      let block: Block;
      let stopReason = "end_turn";
      if (finished !== undefined) {
        result.resolve(finished);
        block = { type: "text", text: "probe done" };
      } else if (!issued && body.tools?.some((t) => t.name === "Bash")) {
        issued = true;
        block = toolUse(`bash -c "$(cat <<'PROBE_END'\n${probeShell}\nPROBE_END\n)"`);
        stopReason = "tool_use";
      } else block = { type: "text", text: "ok" };
      if (body.stream) return sse(block, stopReason);
      return Response.json({
        id: "msg_probe",
        type: "message",
        role: "assistant",
        model: "probe",
        content: [block],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    record,
    toolResult: result.promise,
    stop: () => void server.stop(true),
  };
}

/** Rejects after `ms` unless `promise` settles first. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new ProbeFailed(`${what} did not happen within ${ms / 1000}s`)),
    ms,
  );
  return Promise.race([promise, timeout.promise]).finally(() => clearTimeout(timer));
}

const cliVersion = (cli: ResolvedCli): string => {
  const r = spawnSync(cli.path, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return r.stdout.trim().split(/\s+/)[0] || "unknown";
};

/** A process header line of the shell's output: the first one under the ancestors is the shell's parent (the sandbox's wrapper when the command really ran sandboxed). */
const SANDBOX_FIELD = /^--- pid \d+: (.*)$/m;

/** Runs the real host in remote mode with the canary as the custom provider's token and sends one message to a new bot. */
async function runHost(o: {
  dataRoot: string;
  binary: string;
  auth: "bearer" | "api_key";
  canary: string;
  gateway: Gateway;
  scratch: string;
}): Promise<void> {
  const keyFile = join(o.scratch, "secrets.key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const probePort = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probePort.port;
  await probePort.stop(true);
  const flags = [
    "--mode",
    "remote",
    "--data-root",
    o.dataRoot,
    "--secrets-key-file",
    keyFile,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ];
  const env = { ...process.env };
  const server = Bun.spawn([o.binary, ...flags], {
    cwd: o.scratch,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let log = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) log += decoder.decode(chunk, { stream: true });
  };
  void drain(server.stdout);
  void drain(server.stderr);
  try {
    const started = await within(
      (async () => {
        for (;;) {
          const found = /tomte UI: (http:\/\/\S+)/.exec(log)?.[1];
          if (found) return found;
          if (server.exitCode !== null) fail(`the host exited at start-up:\n${log}`);
          await Bun.sleep(100);
        }
      })(),
      STARTUP_TIMEOUT_MS,
      "the host's start-up line",
    );
    const base = started.replace(/\/$/, "");
    const pairing = Bun.spawnSync([o.binary, "pair", ...flags], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = pairing.stdout.toString().trim();
    if (pairing.exitCode !== 0 || !code) fail(`pair failed: ${pairing.stderr.toString()}`);
    const post = async (path: string, body: object, headers: Record<string, string> = {}) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base, ...headers },
        body: JSON.stringify(body),
      });
      if (!res.ok) fail(`POST ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res.json() as Promise<Record<string, unknown>>;
    };
    const { token } = (await post("/api/pair", { code, name: "probe" })) as { token: string };
    const auth = { authorization: `Bearer ${token}` };
    await post(
      "/api/providers/claude/gateway",
      { baseUrl: o.gateway.url, auth: o.auth, token: o.canary },
      auth,
    );
    await post("/api/bots/new", { name: "Probe", purpose: "", shape: "ball", color: "ink" }, auth);
    await post("/api/send", { text: "run the probe" }, auth);
    await within(o.gateway.toolResult, 120_000, "the shell's result").catch((e) => {
      throw new ProbeFailed(`${(e as Error).message}\nhost log:\n${log.slice(-2000)}`);
    });
  } finally {
    server.kill("SIGTERM");
    const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await server.exited;
    clearTimeout(force);
  }
}

/** Opens the CLI through the SDK with the credential on an extra descriptor and sends it one message. */
async function runFd(o: {
  dataRoot: string;
  mode: Exclude<Mode, "host-env">;
  kind: "pipe" | "file";
  sandbox: boolean;
  extraEnv: Record<string, string>;
  canary: string;
  gateway: Gateway;
  scratch: string;
}): Promise<void> {
  const keyFile = join(o.scratch, "secrets.key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const { config } = parseHostConfig(
    ["--mode", "remote", "--data-root", o.dataRoot, "--secrets-key-file", keyFile],
    process.env,
  );
  const cli =
    resolveCli(o.dataRoot) ??
    fail(
      `no Claude CLI in ${o.dataRoot}; run \`tomte-host install-cli --data-root ${o.dataRoot}\``,
    );
  const credentialEnv: Record<string, string> =
    o.mode === "env-token"
      ? { ANTHROPIC_AUTH_TOKEN: o.canary }
      : {
          [FD_VARIABLE[o.mode]]: String(CREDENTIAL_FD),
          ...(o.mode === "fd-gateway" ? { CLAUDE_CODE_USE_GATEWAY: "1" } : {}),
        };
  const env: Record<string, string | undefined> = {
    ...createClaudeAccess(config, cli).spawnSpec().env,
    ANTHROPIC_BASE_URL: o.gateway.url,
    ...credentialEnv,
    ...o.extraEnv,
  };
  if (env.CLAUDE_CONFIG_DIR) mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const launch = claudeHarness.launch({
    hostServers: [],
    systemPromptAppend: "You are a probe.",
    isolation: o.sandbox ? browserIsolation() : undefined,
  });
  const hasFd = o.mode === "fd-oauth" || o.mode === "fd-gateway";
  let stderr = "";
  /** Set when the CLI dies before it has answered: the SDK's own iteration does not end then. A clean exit is the end of a finished turn. */
  const cliExited = Promise.withResolvers<void>();
  const cliGone = Promise.withResolvers<never>();
  cliGone.promise.catch(() => undefined);
  let answered = false;
  const spawnWithCredential = (s: SpawnOptions): SpawnedProcess => {
    let credential: "pipe" | number = "pipe";
    let file: number | undefined;
    if (hasFd && o.kind === "file") {
      const path = join(o.scratch, "credential");
      writeFileSync(path, o.canary, { mode: 0o600 });
      file = openSync(path, "r");
      unlinkSync(path);
      credential = file;
    }
    const child = spawn(s.command, s.args, {
      cwd: s.cwd,
      env: s.env as NodeJS.ProcessEnv,
      signal: s.signal,
      stdio: hasFd ? ["pipe", "pipe", "pipe", credential] : ["pipe", "pipe", "pipe"],
    });
    if (DEBUG) {
      console.error(`[probe] spawned ${s.command} ${s.args.length} args, pid ${child.pid}`);
      child.on("exit", (code, signal) => console.error(`[probe] cli exited ${code} ${signal}`));
      child.on("error", (e) => console.error(`[probe] cli error ${e.message}`));
    }
    child.on("exit", (code, signal) => {
      cliExited.resolve();
      if (!answered && code !== 0)
        cliGone.reject(new ProbeFailed(`the CLI exited (${code ?? signal}) before it answered`));
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d;
      if (DEBUG) console.error(`[cli stderr] ${d.toString().trimEnd()}`);
    });
    if (file !== undefined) closeSync(file);
    else if (hasFd) {
      const sink = child.stdio[CREDENTIAL_FD];
      if (sink && "end" in sink) sink.end(o.canary);
    }
    return child as unknown as SpawnedProcess;
  };
  const q = query({
    prompt: "run the probe",
    options: {
      pathToClaudeCodeExecutable: cli.path,
      spawnClaudeCodeProcess: spawnWithCredential,
      cwd: o.scratch,
      persistSession: true,
      canUseTool: (_tool, input) => Promise.resolve({ behavior: "allow", updatedInput: input }),
      ...launch.options,
      model: "claude-sonnet-4-5",
      env,
      ...(DEBUG ? { debug: true } : {}),
    },
  });
  try {
    await within(
      Promise.race([
        (async () => {
          for await (const m of q) if (m.type === "result") return;
        })(),
        cliGone.promise,
      ]),
      120_000,
      "the CLI's result",
    );
  } catch (e) {
    throw new ProbeFailed(`${(e as Error).message}\nCLI stderr:\n${stderr.slice(-2000)}`);
  } finally {
    answered = true;
    q.close();
    launch.dispose();
    await Promise.race([cliExited.promise, Bun.sleep(5_000)]);
  }
}

function report(o: {
  mode: Mode;
  /** The positive control: the canary is meant to be found. */
  expectVisible: boolean;
  detail: string;
  version: string;
  record: GatewayRecord;
  output: string;
  canary: string;
}): number {
  const leaked = o.output.includes(o.canary);
  const routes = [...o.output.matchAll(/^CANARY-IN (.*)$/gm)].map((m) => m[1] ?? "");
  const visible = new Set((o.output.match(/^visible pids: (.*)$/m)?.[1] ?? "").trim().split(/\s+/));
  const parent = SANDBOX_FIELD.exec(o.output.split("=== ancestors")[1] ?? "")?.[1];
  const lines = [
    "probe-credential-fd report v1",
    `mode: ${o.mode}${o.detail ? ` (${o.detail})` : ""}`,
    `claude cli: ${o.version}`,
    `canary: generated for this run (not a credential)`,
    `fake gateway: ${o.record.messageRequests} message requests, paths: ${[...o.record.paths].sort().join(", ")}`,
    `canary reached the gateway as the CLI's own auth: ${o.record.canaryArrivedAs ?? "NO"}${o.record.otherAuth ? ` (${o.record.otherAuth} other-auth requests)` : ""}`,
    `shell sees ${visible.size} pids; first ancestor: ${parent ?? "none visible"}`,
    "--- shell output (canary redacted) ---",
    o.output.replace(new RegExp(o.canary, "g"), "<CANARY>").trimEnd(),
    "--- verdict ---",
    ...routes.map((r) => `CANARY-IN ${r}`),
    ...(leaked ? ["CANARY-IN the tool result itself (printed unredacted)"] : []),
    `canary visible to the bot's shell: ${routes.length || leaked ? "YES" : "NO"}`,
  ];
  console.log(lines.join("\n"));
  if (!o.record.canaryArrivedAs) {
    console.error(
      "probe invalid: the CLI never sent the canary as its auth, so it did not read the credential; the result proves nothing",
    );
    return 1;
  }
  const visibleNow = routes.length > 0 || leaked;
  if (o.expectVisible) {
    if (!visibleNow) console.error("probe invalid: the positive control did not find its canary");
    return visibleNow ? 0 : 1;
  }
  return visibleNow ? 3 : 0;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "data-root": { type: "string" },
      host: { type: "string" },
      auth: { type: "string", default: "bearer" },
      "fd-kind": { type: "string", default: "pipe" },
      sandbox: { type: "string", default: "on" },
      env: { type: "string", multiple: true, default: [] },
    },
  });
  const mode = MODES.find((m) => m === positionals[0]);
  const dataRootArg = values["data-root"];
  const kind = values["fd-kind"];
  const auth = values.auth;
  const sandboxArg = values.sandbox;
  if (
    !mode ||
    !dataRootArg ||
    (kind !== "pipe" && kind !== "file") ||
    (auth !== "bearer" && auth !== "api_key") ||
    (sandboxArg !== "on" && sandboxArg !== "off") ||
    (mode === "host-env" && sandboxArg === "off") ||
    (mode === "host-env" && !values.host)
  ) {
    console.error(
      "usage: probe-credential-fd.ts host-env --data-root <dir> --host <binary> [--auth bearer|api_key]\n       probe-credential-fd.ts fd-oauth|fd-gateway --data-root <dir> [--fd-kind pipe|file]\n       probe-credential-fd.ts env-token --data-root <dir>\n       (fd-* and env-token also take --sandbox on|off and --env NAME=VALUE; host-env always runs the host's own sandbox)",
    );
    return 2;
  }
  if (process.platform !== "linux") {
    console.error("the probe runs on Linux only (remote mode and the bwrap sandbox)");
    return 2;
  }
  const extraEnv: Record<string, string> = {};
  for (const pair of values.env) {
    const at = pair.indexOf("=");
    if (at < 1) {
      console.error(`--env wants NAME=VALUE, got "${pair.split("=")[0]}"`);
      return 2;
    }
    extraEnv[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const sandbox = sandboxArg === "on";
  const cliRoot = resolve(dataRootArg);
  const hostBinary = values.host ? resolve(values.host) : undefined;
  if (hostBinary && !existsSync(hostBinary)) {
    console.error(`no host binary at ${hostBinary}`);
    return 2;
  }
  const canary = `canary-${randomBytes(16).toString("hex")}`;
  const scratch = await mkdtemp(join(tmpdir(), "probe-credential-fd-"));
  const gateway = startGateway(canary);
  // Every run starts on an empty data root of its own (so no earlier run's secrets or bots are in the way) that borrows only the CLI.
  const dataRoot = join(scratch, "data");
  mkdirSync(dataRoot);
  symlinkSync(join(cliRoot, "claude-cli"), join(dataRoot, "claude-cli"));
  try {
    const cli =
      resolveCli(dataRoot) ??
      fail(`no Claude CLI in ${cliRoot}; run \`tomte-host install-cli --data-root ${cliRoot}\``);
    if (mode === "host-env" && hostBinary)
      await runHost({ dataRoot, binary: hostBinary, auth, canary, gateway, scratch });
    else if (mode !== "host-env")
      await runFd({ dataRoot, mode, kind, sandbox, extraEnv, canary, gateway, scratch });
    return report({
      mode,
      expectVisible: mode === "env-token" && !sandbox,
      detail:
        mode === "host-env"
          ? `custom provider token, auth=${auth}`
          : mode === "env-token"
            ? `the canary in ANTHROPIC_AUTH_TOKEN in the CLI's env, sandbox ${sandbox ? "on" : "OFF (positive control)"}`
            : `fd ${CREDENTIAL_FD}, ${kind}, ${FD_VARIABLE[mode]}, sandbox ${sandbox ? "on" : "OFF"}`,
      version: cliVersion(cli),
      record: gateway.record,
      output: await within(gateway.toolResult, 5_000, "the shell's result"),
      canary,
    });
  } catch (e) {
    console.error(e instanceof ProbeFailed ? `probe failed: ${e.message}` : e);
    return 1;
  } finally {
    gateway.stop();
    await rm(scratch, { recursive: true, force: true });
    // A CLI told to stop still writes its telemetry into the data root for a moment, which makes the directory again.
    await Bun.sleep(1_000);
    await rm(scratch, { recursive: true, force: true });
  }
}

process.exitCode = await main();
process.exit();
