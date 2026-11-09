import { tmpdir } from "node:os";
import { basename } from "node:path";

import {
  buildArgv,
  readRelayConfig,
  refuseTarget,
  type RelayAdapter,
  type RelayJob,
} from "./relay-config.ts";

/** The longest answer the host relays; a longer one is shown as a failed relay, since an argument list is not a place for a document. */
export const MAX_RELAY_ANSWER = 8192;

/** How much of each output stream is kept for the error line. */
const OUTPUT_LIMIT = 4096;
/** After the adapter exited, how long its output pipes may stay open (a grandchild can hold them). */
const DRAIN_MS = 500;
/** The only variables of the host's environment an adapter gets; the host's tokens and keys are not among them. */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
];

type RelayOutcome = { ok: true } | { error: string };

export interface RelayOptions {
  /** The operator's configuration file. */
  configPath: string;
  /** Remote mode: every adapter must restrict its agents. */
  remote: boolean;
}

export interface Relay {
  /** Runs the adapter for one answer. Never throws: every way it can go wrong is an `error` line for the user. */
  run(job: RelayJob): Promise<RelayOutcome>;
  /** Kills adapters that are running; their `run` settles with an error that says delivery is unknown. */
  stop(): void;
}

/** Keeps the first `OUTPUT_LIMIT` bytes of a stream and drains the rest, so a chatty adapter cannot fill a pipe and hang. */
function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const done = (async () => {
    for await (const chunk of stream) {
      if (size < OUTPUT_LIMIT) chunks.push(chunk.subarray(0, OUTPUT_LIMIT - size));
      size += chunk.length;
    }
  })().catch(() => undefined);
  return { done, text: () => Buffer.concat(chunks).toString("utf8") };
}

/** The last non-blank line of the adapter's output, one line of printable text. */
function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/\p{Cc}/gu, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((l) => l !== "");
  const line = lines[lines.length - 1] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function environment(adapter: RelayAdapter): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...adapter.env };
}

/**
 * Runs the operator's relay adapters (ADR-0008): the program and its argument list come from the configuration file, an
 * event only fills the validated slots. The program is started directly with an argument array (no shell), in the
 * temporary directory, with a small environment, a timeout and bounded output.
 */
export function createRelay({ configPath, remote }: RelayOptions): Relay {
  const running = new Set<{ kill(): void; stopped: boolean }>();

  async function run(job: RelayJob): Promise<RelayOutcome> {
    const config = readRelayConfig(configPath, remote);
    if (!config.ok) return { error: config.reason };
    const adapter = config.config.adapters[job.reply.kind];
    if (!adapter) return { error: `no relay adapter named "${job.reply.kind}" is configured` };
    const refusal = refuseTarget(adapter, job.reply);
    if (refusal !== undefined) return { error: refusal };

    const handle = { kill: () => {}, stopped: false };
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const proc = Bun.spawn([adapter.command, ...buildArgv(adapter, job)], {
        cwd: tmpdir(),
        env: environment(adapter),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      handle.kill = () => proc.kill("SIGKILL");
      running.add(handle);
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, adapter.timeoutMs);
      const out = collect(proc.stdout);
      const err = collect(proc.stderr);
      const code = await proc.exited;
      await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(DRAIN_MS)]);
      if (handle.stopped)
        return {
          error: "the host stopped before the relay finished; the reply may have been delivered",
        };
      if (timedOut)
        return {
          error: `${basename(adapter.command)} did not finish within ${adapter.timeoutMs} ms; the reply may have been delivered`,
        };
      if (code === 0) return { ok: true };
      const said = lastLine(err.text()) || lastLine(out.text());
      return {
        error: `${basename(adapter.command)} exited with ${code}${said ? `: ${said}` : ""}`,
      };
    } catch (e) {
      const why = (e as NodeJS.ErrnoException).code ?? "an error";
      return { error: `${basename(adapter.command)} could not be started (${why})` };
    } finally {
      clearTimeout(timer);
      running.delete(handle);
    }
  }

  return {
    run,
    stop() {
      for (const handle of running) {
        handle.stopped = true;
        handle.kill();
      }
    },
  };
}
