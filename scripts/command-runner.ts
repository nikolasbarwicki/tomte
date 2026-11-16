// Running an external command, behind an interface the signing scripts take as a parameter. The real implementation is
// here; the tests of the signing flows pass a recording fake and never start `security`, `codesign` or `notarytool`.
export interface Ran {
  stdout: string;
  stderr: string;
}

/** Runs `command` (argv, no shell) with `env` laid over this process's environment; throws a {@link CommandError} on a non-zero exit. */
export type Runner = (command: readonly string[], env?: Record<string, string>) => Promise<Ran>;

/**
 * A command that exited non-zero. The message holds the command's first two words and its stderr but never its other
 * arguments (they may hold a secret); the exit code and both streams are kept for a caller that needs to read them.
 */
export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} failed (exit ${code}): ${stderr.trim()}`);
  }
}

/** Children of {@link spawnRunner} that are still running, so a signal handler can stop them before it exits. */
const running = new Set<{ kill: () => void }>();

export function stopRunningCommands(): void {
  for (const child of running) child.kill();
}

export const spawnRunner: Runner = async (command, env) => {
  const child = Bun.spawn([...command], {
    stdout: "pipe",
    stderr: "pipe",
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  running.add(child);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new CommandError(command.slice(0, 2).join(" "), code, stdout, stderr);
    return { stdout, stderr };
  } finally {
    running.delete(child);
  }
};
