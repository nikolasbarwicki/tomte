import { InvalidConfig, parseHostConfig, type HostConfig } from "./config.ts";

/** Whether this process is the compiled host binary, not Bun running the source. */
export const isCompiledHost = () => Bun.isStandaloneExecutable;

const PLAIN = { win32: /^[\w./@%+=:,\\-]+$/, posix: /^[\w./@%+=:,-]+$/ };

/** `word` as one shell word: unchanged when it holds only plain path and flag characters, else quoted (double quotes on Windows, single quotes elsewhere). */
function shellWord(word: string, platform: NodeJS.Platform): string {
  const windows = platform === "win32";
  if ((windows ? PLAIN.win32 : PLAIN.posix).test(word)) return word;
  return windows ? `"${word}"` : `'${word.replaceAll("'", "'\\''")}'`;
}

/** `words` as one command line to paste into a shell. */
export function commandLine(
  words: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return words.map((w) => shellWord(w, platform)).join(" ");
}

/** The command that runs the host subcommand `args` the way this host was started: the binary itself, or `bun run host` in the source checkout. */
export function hostCommand(...args: string[]): string {
  return commandLine(
    isCompiledHost() ? [process.execPath, ...args] : ["bun", "run", "host", ...args],
  );
}

/** The command that starts the host server with `args` (a bot id, flags) the way this host was started: the binary itself, or `bun run ui`. */
export function serverCommand(...args: string[]): string {
  return commandLine(
    isCompiledHost() ? [process.execPath, ...args] : ["bun", "run", "ui", ...args],
  );
}

/** `parseHostConfig` over this process's arguments and environment. A startup entry that gets bad flags or environment prints the problem and exits with code 2. */
export function parseStartupConfig(): { config: HostConfig; positionals: string[] } {
  try {
    return parseHostConfig(process.argv.slice(2), process.env);
  } catch (e) {
    if (!(e instanceof InvalidConfig)) throw e;
    console.error(e.message);
    process.exit(2);
  }
}
