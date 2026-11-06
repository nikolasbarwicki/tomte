import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { authCommand, installManagedCli, resolveCli, type ResolvedCli } from "./harness/cli.ts";
import { installManagedEngine } from "./browser/engine.ts";
import { Thread, type HostDelegate } from "./bots/thread.ts";
import { botContext, botFilesPath, createBot, currentSession, getBot, newSession, touchBot } from "./bots/index.ts";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";

const log = (l: string) => console.error(l);

function sdkVersion(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
  return JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")).version;
}

/** Non-interactive host policy for this script: answers come from the host, never CLI stdin. */
function delegate(answer: string): HostDelegate {
  return {
    askUser: async (q) => {
      log(`[host] answering ask_user from host: ${JSON.stringify(answer)} (question: ${q})`);
      return answer;
    },
    approve: async (tool, input, reason) => {
      log(`[host] approval request: ${tool} (${reason}) -> allow`);
      return { behavior: "allow", updatedInput: input };
    },
  };
}

function preflight(): ResolvedCli {
  const cli = resolveCli();
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  if (!cli && !hasKey) {
    log("refusing to start: no ANTHROPIC_API_KEY in the environment and no claude binary (CLAUDE_PATH, managed copy, PATH)");
    process.exit(2);
  }
  if (!cli) {
    log("refusing to start: no claude binary resolved; set CLAUDE_PATH or run `host.ts install-cli`");
    process.exit(2);
  }
  if (!hasKey) log("[host] warning: ANTHROPIC_API_KEY not set; the CLI will use its own stored login (not valid for third-party products)");
  return cli;
}

function banner(cli: ResolvedCli, sessionId: string) {
  console.log(`sdk=@anthropic-ai/claude-agent-sdk@${sdkVersion()}`);
  console.log(`cli=${cli.path} (${cli.source})`);
  console.log(`session=${sessionId}`);
}

/** Acceptance bots keep user memory inside the throwaway workspace, away from the real one. */
const testBot = (cwd: string, sessionId: string) =>
  botContext(cwd, getBot(cwd, sessionId) ?? createBot(cwd, "acceptance", "", sessionId), { user: join(cwd, ".host", "user-memory.md") });

async function phaseCreate(cwd: string, sessionId: string) {
  const cli = preflight();
  banner(cli, sessionId);
  const t = new Thread({ cli, cwd, ...testBot(cwd, sessionId), delegate: delegate("yes"), log });
  const r = await t.send("create hello.txt containing hello");
  t.close();
  const file = join(botFilesPath(cwd, sessionId), "hello.txt");
  if (!existsSync(file)) throw new Error("hello.txt was not created");
  console.log(`result=${r.result.subtype} hello.txt=${JSON.stringify(readFileSync(file, "utf8"))}`);
}

async function phaseResume(cwd: string, sessionId: string) {
  const cli = preflight();
  banner(cli, sessionId);
  const t = new Thread({ cli, cwd, ...testBot(cwd, sessionId), resume: true, idleMs: 5 * 60_000, delegate: delegate("notes.txt"), log });
  const r1 = await t.send("what file did you create?");
  console.log(`answer=${r1.text}`);
  if (!/hello\.txt/.test(r1.text)) throw new Error("resumed answer did not name hello.txt");

  await t.setModel("haiku");
  await t.setEffort("low");

  const r2 = await t.send(
    "Create one more text file. Before writing anything, you must ask the user for the filename with the ask_user tool, then create that file containing 'ok'.",
  );
  t.close();
  if (!r2.toolsUsed.includes("mcp__host__ask_user")) throw new Error("model did not call ask_user");
  if (!existsSync(join(botFilesPath(cwd, sessionId), "notes.txt"))) throw new Error("file named by the host answer was not created");
  console.log(`ask_user ok: tools=${r2.toolsUsed.join(",")}`);
}

function runPhase(phase: string, cwd: string, sessionId: string) {
  const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], phase, cwd, sessionId], { stdio: "inherit" });
  if (r.status !== 0) {
    log(`phase ${phase} failed with exit ${r.status}`);
    process.exit(1);
  }
}


async function chat(cwdArg?: string, botArg?: string) {
  const cli = preflight();
  const cwd = realpathSync(cwdArg ?? process.cwd());
  const bot = botArg ? getBot(cwd, botArg) : createBot(cwd, "CLI chat");
  if (!bot) throw new Error(`no bot ${botArg} in ${cwd}`);
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines: string[] = [];
  const waiters: ((l: string | null) => void)[] = [];
  let closed = false;
  rl.on("line", (l) => (waiters.length ? waiters.shift()!(l) : lines.push(l)));
  rl.on("close", () => {
    closed = true;
    for (const w of waiters.splice(0)) w(null);
  });
  const ask = (prompt: string): Promise<string | null> => {
    process.stdout.write(prompt);
    if (lines.length) return Promise.resolve(lines.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((r) => waiters.push(r));
  };
  const ui: HostDelegate = {
    askUser: async (q) => (await ask(`\n[claude asks] ${q}\n> `)) ?? "(no answer)",
    approve: async (tool, input, reason) => {
      const a = (await ask(`\n[approve ${tool}? ${reason}] ${JSON.stringify(input).slice(0, 300)}\n(y/N) `)) ?? "";
      return /^y/i.test(a) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "user declined" };
    },
  };
  const resume = !!(await getSessionInfo(currentSession(bot), { dir: cwd }));
  const open = (resume: boolean) => new Thread({ cli, cwd, ...botContext(cwd, bot), resume, idleMs: 10 * 60_000, delegate: ui, log: () => {} });
  let t = open(resume);
  banner(cli, t.sessionId);
  console.log(`bot=${bot.name}\ncwd=${cwd}\ncommands: /model <name>  /effort <low|medium|high|max>  /new  /quit`);
  while (true) {
    const raw = await ask("\nyou> ");
    if (raw === null || raw.trim() === "/quit") break;
    const line = raw.trim();
    if (!line) continue;
    const [c, arg] = line.split(/\s+/, 2);
    try {
      if (c === "/model" && arg) await t.setModel(arg);
      else if (c === "/effort" && arg) await t.setEffort(arg as Parameters<Thread["setEffort"]>[0]);
      else if (c === "/new") {
        t.close("new session");
        newSession(cwd, bot);
        t = open(false);
        console.log(`new session started: ${t.sessionId}`);
      } else {
        touchBot(cwd, bot);
        process.stdout.write("claude> ");
        await t.send(line, (m) => {
          if (m.type === "stream_event" && m.event.type === "content_block_delta" && m.event.delta.type === "text_delta")
            process.stdout.write(m.event.delta.text);
          if (m.type === "assistant")
            for (const b of m.message.content) if (b.type === "tool_use") process.stdout.write(`\n  [tool ${b.name}]\n`);
        });
        process.stdout.write("\n");
      }
    } catch (e) {
      console.log(`\n[error] ${(e as Error).message}`);
    }
  }
  t.close();
  rl.close();
  console.log(`resume later with: bun src/host.ts chat ${cwd} ${bot.id}`);
}
const [cmd, a1, a2] = process.argv.slice(2);
try {
  switch (cmd) {
    case "create":
      await phaseCreate(a1, a2);
      break;
    case "chat":
      await chat(a1, a2);
      break;
    case "resume":
      await phaseResume(a1, a2);
      break;
    case "install-cli":
      console.log(`installed ${await installManagedCli(a1)}`);
      break;
    case "install-browser":
      console.log(`installed ${await installManagedEngine(a1)}`);
      break;
    case "browser-smoke":
      await (await import("./browser/smoke.ts")).runBrowserSmoke();
      break;
    case "auth-status":
    case "auth-login": {
      const cli = resolveCli();
      if (!cli) throw new Error("no claude binary resolved");
      process.exit(await authCommand(cli, cmd === "auth-status" ? "status" : "login"));
    }
    default: {
      preflight();
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "claudebot-ws-")));
      const sessionId = randomUUID();
      log(`[host] workspace=${cwd}`);
      runPhase("create", cwd, sessionId); // process exits: the CLI goes with it
      runPhase("resume", cwd, sessionId);
      console.log("acceptance: ok");
    }
  }
  process.exit(0);
} catch (e) {
  log(`error: ${(e as Error).message}`);
  process.exit(1);
}
