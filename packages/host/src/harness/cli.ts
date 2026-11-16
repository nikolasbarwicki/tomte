import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const isWin = process.platform === "win32";
/** Where the managed Claude CLI is installed: `claude-cli/` in the data root. */
const managedRoot = (dataRoot: string) => join(dataRoot, "claude-cli");

export type ResolvedCli = {
  path: string;
  source: "CLAUDE_PATH" | "managed" | "PATH";
  /** Set only when the resolved path is an npm .cmd wrapper we could not unwrap. */
  needsShell: boolean;
};

/** musl ships its loader as `/lib/ld-musl-<arch>.so.1`; glibc's lives in `/lib64` on x86_64, so absence of a glibc path proves nothing. */
export function isMusl(): boolean {
  return (
    process.platform === "linux" &&
    existsSync(`/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`)
  );
}

function platformPackage(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os =
    process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  return `@anthropic-ai/claude-code-${os}-${arch}${isMusl() ? "-musl" : ""}`;
}

function managedBinary(dataRoot: string): string | undefined {
  const marker = join(managedRoot(dataRoot), "current");
  if (!existsSync(marker)) return undefined;
  const p = readFileSync(marker, "utf8").trim();
  return existsSync(p) ? p : undefined;
}

function onPath(): string | undefined {
  const names = isWin ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const n of names) {
      const p = join(dir, n);
      if (dir && existsSync(p)) return p;
    }
  }
  return undefined;
}

/** npm on Windows installs claude.cmd; the SDK spawns non-.js paths without a shell, which fails with EINVAL. */
function unwrapNpmShim(p: string): string | undefined {
  const pkg = join(dirname(p), "node_modules", "@anthropic-ai", "claude-code");
  for (const c of [join(pkg, "bin", "claude.exe"), join(pkg, "cli.js")])
    if (existsSync(c)) return c;
  return undefined;
}

export function resolveCli(dataRoot: string): ResolvedCli | undefined {
  const pick = (
    path: string | undefined,
    source: ResolvedCli["source"],
  ): ResolvedCli | undefined => {
    if (!path || !existsSync(path)) return undefined;
    if (isWin && /\.(cmd|bat|ps1)$/i.test(path)) {
      const real = unwrapNpmShim(path);
      return real ? { path: real, source, needsShell: false } : { path, source, needsShell: true };
    }
    return { path, source, needsShell: false };
  };
  return (
    pick(process.env.CLAUDE_PATH, "CLAUDE_PATH") ??
    pick(managedBinary(dataRoot), "managed") ??
    pick(onPath(), "PATH")
  );
}

/** The fields of an npm registry version document the install reads. */
const NpmVersion = z.object({
  version: z.string(),
  dist: z.object({ tarball: z.string(), integrity: z.string() }),
});

/** Download Anthropic's platform package from npm, verify dist.integrity, extract it into the data root. */
export async function installManagedCli(dataRoot: string, version = "latest"): Promise<string> {
  const name = platformPackage();
  const meta = NpmVersion.parse(
    await (await fetch(`https://registry.npmjs.org/${name}/${version}`)).json(),
  );
  const [algo = "", expected] = [
    meta.dist.integrity.split("-")[0],
    meta.dist.integrity.slice(meta.dist.integrity.indexOf("-") + 1),
  ];
  const bytes = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const actual = createHash(algo).update(bytes).digest("base64");
  if (actual !== expected) throw new Error(`integrity mismatch for ${name}@${meta.version}`);
  const dest = join(managedRoot(dataRoot), meta.version);
  mkdirSync(dest, { recursive: true });
  const tgz = join(tmpdir(), `claude-${meta.version}-${process.pid}.tgz`);
  writeFileSync(tgz, bytes);
  const r = spawnSync("tar", ["-xzf", tgz, "-C", dest], { stdio: ["ignore", 2, 2] });
  rmSync(tgz, { force: true });
  if (r.status !== 0) throw new Error("tar extraction failed");
  const bin = findBinary(join(dest, "package"));
  if (!bin) throw new Error(`no claude binary inside ${name}`);
  writeFileSync(join(managedRoot(dataRoot), "current"), bin);
  return bin;
}

function findBinary(dir: string): string | undefined {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const f = findBinary(p);
      if (f) return f;
    } else if (e.name === (isWin ? "claude.exe" : "claude")) return p;
  }
  return undefined;
}

/** Fallback only: run a .cmd wrapper through cmd.exe and kill the whole tree on kill(). */
export function cmdExeSpawner(opts: SpawnOptions): SpawnedProcess {
  const child: ChildProcess = spawn(
    "cmd.exe",
    ["/d", "/s", "/c", `"${[opts.command, ...opts.args].map((a) => `"${a}"`).join(" ")}"`],
    {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "inherit"],
      windowsVerbatimArguments: true,
    },
  );
  const killTree = () => {
    if (child.pid && child.exitCode === null)
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    return true;
  };
  opts.signal?.addEventListener("abort", killTree);
  return Object.assign(child, { kill: killTree }) as unknown as SpawnedProcess;
}

/** PATH from the login shell when the host was not launched from a terminal (e.g. a GUI/launchd). */
export function loginShellPath(): string | undefined {
  if (process.stdin.isTTY || isWin) return process.env.PATH;
  const sh = process.env.SHELL ?? "/bin/zsh";
  const r = spawnSync(sh, ["-ilc", 'printf "%s" "$PATH"'], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 && r.stdout ? r.stdout : process.env.PATH;
}

/** `claude auth status` or `claude auth login` in the foreground with the caller's terminal, in `env`; resolves with its exit code. */
export function authCommand(
  cli: ResolvedCli,
  sub: "status" | "login",
  env: Record<string, string | undefined>,
): Promise<number> {
  return new Promise((res) => {
    const p = spawn(cli.path, ["auth", sub], {
      stdio: "inherit",
      shell: cli.needsShell,
      env: env as NodeJS.ProcessEnv,
    });
    p.on("exit", (c) => res(c ?? 1));
  });
}
