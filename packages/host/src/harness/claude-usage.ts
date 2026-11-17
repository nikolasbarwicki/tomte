import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UsageWindow } from "@tomte/contract/api";
import { z } from "zod";

import { cmdExeSpawner, type ResolvedCli } from "./cli.ts";

/** How long the CLI may take to start and answer before the check fails. */
const USAGE_TIMEOUT_MS = 20_000;

/** The windows the page shows, in this order: the session limit, then the weekly ones. */
const WINDOWS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_oauth_apps",
] as const;

const Reading = z.object({ utilization: z.number().nullish(), resets_at: z.string().nullish() });
type Reading = z.infer<typeof Reading>;

/** The part of the CLI's experimental `get_usage` answer the host reads; parsed, because its shape may change with any CLI release. */
const UsageAnswer = z.object({
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: Reading.nullish(),
      seven_day: Reading.nullish(),
      seven_day_opus: Reading.nullish(),
      seven_day_sonnet: Reading.nullish(),
      seven_day_oauth_apps: Reading.nullish(),
      model_scoped: z.array(Reading.extend({ display_name: z.string() })).nullish(),
    })
    .nullish(),
});

const windowOf = (window: string, name: string | null, w: Reading): UsageWindow => {
  const resetsAt = w.resets_at ? Date.parse(w.resets_at) : NaN;
  return {
    window,
    name,
    percent: w.utilization == null ? null : Math.min(100, Math.max(0, w.utilization)),
    resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
  };
};

/** The plan usage windows of an answer: the session and weekly windows the CLI reported, then the per-model weekly ones. */
function usageWindows(answer: unknown): { available: boolean; windows: UsageWindow[] } {
  const a = UsageAnswer.parse(answer);
  const limits = a.rate_limits;
  if (!a.rate_limits_available || !limits) return { available: false, windows: [] };
  const windows: UsageWindow[] = [];
  for (const key of WINDOWS) {
    const w = limits[key];
    if (w) windows.push(windowOf(key, null, w));
  }
  for (const m of limits.model_scoped ?? []) windows.push(windowOf("model", m.display_name, m));
  return { available: true, windows };
}

/** A prompt that never sends a message: the query is opened only for its control requests. */
const silent: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
};

/**
 * Asks the CLI for the subscription's plan usage, the data behind its `/usage` command, through a short-lived query that sends no
 * message (no model call, no session file). Uses the SDK's experimental usage request, so a CLI that changes or drops it makes this
 * reject; the caller shows the failure.
 */
export async function readClaudeUsage(
  cli: ResolvedCli,
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<{ available: boolean; windows: UsageWindow[] }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), USAGE_TIMEOUT_MS);
  const q = query({
    prompt: silent,
    options: {
      pathToClaudeCodeExecutable: cli.path,
      ...(cli.needsShell ? { spawnClaudeCodeProcess: cmdExeSpawner } : {}),
      cwd,
      env,
      settingSources: [],
      persistSession: false,
      abortController: abort,
    },
  });
  try {
    await q.initializationResult();
    return usageWindows(
      await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
    );
  } catch (e) {
    if (abort.signal.aborted) throw new Error("the Claude CLI did not report usage in time");
    throw e;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}
