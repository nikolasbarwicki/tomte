import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

import { LaunchToken, SidecarReady } from "@tomte/contract/sidecar";

/** The first launch installs the Claude CLI, which downloads it, so the ready line can be slow. */
const READY_TIMEOUT_MS = 180_000;
/** The host needs this long to stop its bots and browsers after its stdin ends; past it, it is killed. */
const STOP_TIMEOUT_MS = 30_000;
const LOG_TAIL_BYTES = 4000;

export interface Sidecar {
  /** The host's client listener: the web UI and `/api/*`. */
  clientUrl: string;
  /** The launch token the host registered as this device's token; it is the value of the session cookie. Never log it or put it in a URL. */
  token: string;
  /** Settles when the host process has ended, for whatever reason. */
  exited: Promise<void>;
  /** Ends the host's stdin and waits for it to exit, killing it after a timeout. */
  stop(): Promise<void>;
}

/** The host did not become ready; the message is fit to show the user and includes the end of the host's log. */
export class SidecarStartError extends Error {}

/** The tail of the host log, for an error the user sees. */
export function logTail(logFile: string): string {
  return readFileSync(logFile, "utf8").slice(-LOG_TAIL_BYTES).trim();
}

/** Starts the host in sidecar mode: writes it a fresh launch token, keeps its stdin open for its whole life and waits for its ready line. Its stderr and, after the ready line, its stdout go to `logFile`. */
export async function startSidecar(
  hostPath: string,
  logFile: string,
  timeouts: { readyMs: number; stopMs: number } = {
    readyMs: READY_TIMEOUT_MS,
    stopMs: STOP_TIMEOUT_MS,
  },
): Promise<Sidecar> {
  mkdirSync(dirname(logFile), { recursive: true });
  const log = openSync(logFile, "a");
  let logOpen = true;
  const write = (text: string) => void (logOpen && writeSync(log, text));
  const note = (text: string) => write(`${new Date().toISOString()} [desktop] ${text}\n`);
  const token = LaunchToken.parse(randomBytes(32).toString("base64url"));

  const child = spawn(hostPath, ["--sidecar"], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve) => {
    const finish = (what: string) => {
      if (!logOpen) return;
      note(what);
      logOpen = false;
      closeSync(log);
      resolve();
    };
    child.once("close", (code, signal) => finish(`host exited (${signal ?? code})`));
    // A host that never started (a missing binary) is closed by this event alone; without a pid it is the only one.
    child.once("error", (error) => {
      if (child.pid === undefined) finish(`host did not start: ${error.message}`);
    });
  });
  const stderr = new StringDecoder("utf8");
  child.stderr.on("data", (chunk: Buffer) => write(stderr.write(chunk)));
  // A host that is already gone closes the pipe under us; its exit is reported through `exited`.
  child.stdin.on("error", () => {});
  child.stdin.write(`${token}\n`);

  const stop = async () => {
    child.stdin.end();
    const timer = setTimeout(() => {
      note(`host did not exit within ${timeouts.stopMs / 1000}s of its stdin ending; killing it`);
      child.kill("SIGKILL");
    }, timeouts.stopMs);
    await exited;
    clearTimeout(timer);
  };

  const ready = Promise.withResolvers<string>();
  const lines = createInterface({ input: child.stdout });
  let first = true;
  lines.on("line", (line) => {
    if (!first) return write(`${line}\n`);
    first = false;
    const parsed = SidecarReady.safeParse(parseJson(line));
    if (parsed.success) ready.resolve(parsed.data.clientUrl);
    else ready.reject(new Error("the host's first output line was not a ready message"));
  });
  void exited.then(() => ready.reject(new Error("the host exited before it was ready")));
  const timer = setTimeout(
    () => ready.reject(new Error(`the host was not ready after ${timeouts.readyMs / 1000}s`)),
    timeouts.readyMs,
  );

  try {
    const clientUrl = await ready.promise;
    return { clientUrl, token, exited, stop };
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    const tail = logTail(logFile);
    const reason = error instanceof Error ? error.message : String(error);
    throw new SidecarStartError(tail ? `${reason}\n\n${tail}` : reason);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
