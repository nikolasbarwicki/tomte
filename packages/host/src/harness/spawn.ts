import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import { cmdExeSpawner, type ResolvedCli } from "./cli.ts";

/** The descriptor a CLI child's credential arrives on: the first one after stdin, stdout and stderr. */
export const CREDENTIAL_FD = 3;

/**
 * What one CLI child is started with: its environment, and the credential it reads from a descriptor. The environment names the
 * descriptor (`CLAUDE_CODE_*_FILE_DESCRIPTOR`) and never holds the credential, which a bot's shell, a child of the CLI, could read.
 */
export interface SpawnSpec {
  env: Record<string, string | undefined>;
  credential?: string;
}

/** The `stdio` of a child that gets `spec`'s credential: a pipe (a socket pair, never a file, which `/proc/<pid>/fd` can reopen) on `CREDENTIAL_FD`. */
export const stdioFor = (spec: SpawnSpec): ("pipe" | "ignore")[] =>
  spec.credential === undefined ? [] : ["pipe"];

/** Writes the credential to the child's descriptor and ends it, which is the end of file the CLI reads to. */
export function handCredential(child: ChildProcess, spec: SpawnSpec): void {
  if (spec.credential === undefined) return;
  const sink = child.stdio[CREDENTIAL_FD] as Writable | null | undefined;
  // A child that exits before it reads leaves a broken pipe; the child's own failure is what matters then.
  sink?.on("error", () => {});
  sink?.end(spec.credential);
}

/**
 * The `spawnClaudeCodeProcess` option for a query whose CLI child gets `spec`, empty when the SDK's own spawn does. A credential
 * needs a spawn of ours, because the SDK's has no descriptor to give; `stderr` is what the SDK's `stderr` option would have been
 * given, which a spawn of ours has to feed itself.
 */
export function spawnOptions(
  cli: ResolvedCli,
  spec: SpawnSpec,
  stderr?: (data: string) => void,
): { spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess } {
  if (spec.credential === undefined)
    return cli.needsShell ? { spawnClaudeCodeProcess: cmdExeSpawner } : {};
  if (cli.needsShell)
    throw new Error("a credential cannot be handed to a Claude CLI that runs through cmd.exe");
  return {
    spawnClaudeCodeProcess: (o) => {
      const child = spawn(o.command, o.args, {
        cwd: o.cwd,
        env: o.env as NodeJS.ProcessEnv,
        signal: o.signal,
        stdio: ["pipe", "pipe", "pipe", ...stdioFor(spec)],
        windowsHide: true,
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => stderr?.(d));
      handCredential(child, spec);
      return child as unknown as SpawnedProcess;
    },
  };
}
