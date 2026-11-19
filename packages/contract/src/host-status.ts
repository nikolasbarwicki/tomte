// What every client needs to know about a host, in one value the host derives and publishes on the event stream.
import { z } from "zod";

/** Whether the Claude CLI holds a sign-in. `unknown`: `auth status` could not run or its output did not parse. */
export const ClaudeState = z.enum(["signed-in", "signed-out", "unknown"]);
export type ClaudeState = z.infer<typeof ClaudeState>;

/** How the host's Claude CLI is signed in: `subscription` is the CLI's own sign-in, `long-lived-token` the token pasted in Models (from `claude setup-token`), `custom-provider` the gateway set in Models. */
export const ClaudeMethod = z.enum(["subscription", "long-lived-token", "custom-provider"]);

export const ClaudeStatus = z.object({
  state: ClaudeState,
  method: ClaudeMethod.exactOptional(),
  /** Billing variables found in the host's environment and deliberately not passed on to the CLI. */
  ignoredEnv: z.array(z.string()),
  /** When the CLI was last asked, in epoch milliseconds; 0 before the first answer. */
  checkedAt: z.number(),
  /** Why `state` is `signed-out` when the host knows more than the CLI does: `token-rejected`, a CLI turn failed to authenticate with the long-lived token. The CLI's `auth status` cannot tell, so it clears only when the token is replaced or removed. */
  reason: z.literal("token-rejected").exactOptional(),
});
export type ClaudeStatus = z.infer<typeof ClaudeStatus>;

const ReleaseOffer = z.object({
  version: z.string(),
  notesUrl: z.string(),
  raisesShellApi: z.boolean(),
});

/**
 * How this host's own update is handled:
 * - `bundled`: the desktop app replaces its own sidecar's binary.
 * - `unmanaged`: no update helper is installed (or it cannot serve this host), so the host cannot update itself; `reason` says why.
 * - `current`: the release feed names nothing newer than this host. `checkedAt` is when the feed last answered, in epoch
 *   milliseconds; 0 before the first answer, when nothing is known yet. `skipped` is the newest release when it is the one this host
 *   rolled back from: it is not offered as `available` and not applied automatically until the feed names a newer one, but `apply`
 *   still installs it, so the owner can say they want it after all.
 * - `available`: a newer release exists. `raisesShellApi` is whether the release speaks a higher shell API than this host (a higher minimum or maximum), which an older desktop app may not.
 * - `draining`: an update to `version` was asked for when idle. New turns are refused and routines wait while `running` units of work
 *   (turns, double-loop fronts with work in flight, headless runs) finish; `since` is when the wait began. `overdue` says it has gone on
 *   for 30 minutes, which is when Update now is offered.
 * - `applying`: the request is with the update helper, which replaces the binary and restarts the host.
 * - `failed`: the update to `version` did not happen, `reason` says why; `rolledBackTo` is the version the helper put back, when it had to.
 *   It stays until the owner acts on it (another update, or cancel) and survives the restart the rollback causes.
 * `draining`, `applying` and `failed` carry `rollback: true` when the owner asked to go back to `version` instead of forward to it;
 * a failed rollback changed nothing that `reason` does not say, and is only dismissed.
 */
export const UpdateStatus = z.discriminatedUnion("status", [
  z.object({ status: z.literal("bundled") }),
  z.object({ status: z.literal("unmanaged"), reason: z.string() }),
  z.object({
    status: z.literal("current"),
    checkedAt: z.number(),
    skipped: ReleaseOffer.exactOptional(),
  }),
  z.object({ status: z.literal("available"), ...ReleaseOffer.shape }),
  z.object({
    status: z.literal("draining"),
    version: z.string(),
    running: z.number(),
    since: z.number(),
    overdue: z.boolean(),
    rollback: z.literal(true).exactOptional(),
  }),
  z.object({
    status: z.literal("applying"),
    version: z.string(),
    rollback: z.literal(true).exactOptional(),
  }),
  z.object({
    status: z.literal("failed"),
    version: z.string(),
    reason: z.string(),
    rolledBackTo: z.string().exactOptional(),
    rollback: z.literal(true).exactOptional(),
  }),
]);
export type UpdateStatus = z.infer<typeof UpdateStatus>;

/** What is wrong with the host itself, whichever bot is open. Derived from the facts, never stored, so it ends the moment its cause does. */
export const HostProblem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claude-signed-out"),
    reason: z.literal("token-rejected").exactOptional(),
  }),
  z.object({
    kind: z.literal("update-failed"),
    version: z.string(),
    rolledBackTo: z.string().exactOptional(),
    rollback: z.literal(true).exactOptional(),
  }),
]);
export type HostProblem = z.infer<typeof HostProblem>;

/** "Update to 0.4.2 failed, rolled back to 0.4.1": the one wording of a failed update, in the banner, the tray and the channel message. */
export function updateFailedText(p: {
  version: string;
  rolledBackTo?: string | undefined;
  rollback?: true | undefined;
}): string {
  if (p.rollback) return `Rollback to ${p.version} failed`;
  return `Update to ${p.version} failed${p.rolledBackTo === undefined ? "" : `, rolled back to ${p.rolledBackTo}`}`;
}

/** The host's problems, derived from the facts its owners keep. The one place that says what counts as a problem. */
export function problemsOf(claude: ClaudeStatus, update: UpdateStatus): HostProblem[] {
  const problems: HostProblem[] = [];
  if (claude.state === "signed-out")
    problems.push({
      kind: "claude-signed-out",
      ...(claude.reason !== undefined && { reason: claude.reason }),
    });
  if (update.status === "failed")
    problems.push({
      kind: "update-failed",
      version: update.version,
      ...(update.rolledBackTo !== undefined && { rolledBackTo: update.rolledBackTo }),
      ...(update.rollback && { rollback: true as const }),
    });
  return problems;
}

export const HostStatus = z.object({
  version: z.string(),
  mode: z.enum(["local", "remote"]),
  claude: ClaudeStatus,
  update: UpdateStatus,
  /** Whether the host applies an update by itself when one is available and it is idle; off unless the owner turned it on. */
  autoUpdate: z.boolean().default(false),
  /** `problemsOf` the facts above; empty when the host is well. */
  problems: z.array(HostProblem),
  /** The one earlier version the helper still holds, offered only while going back to it is safe: it opens the current database (the same schema). */
  rollbackTo: z.string().exactOptional(),
  /**
   * The earlier version, when it cannot open the current database (an older schema) but the copy taken before the update can replace it:
   * `version` is the release, `snapshotAt` when the copy was taken (epoch milliseconds). Going back means losing every change since then,
   * so a page asks for it explicitly (`UpdateAction` `rollback` with `restoreSnapshot`). Never present together with `rollbackTo`.
   */
  restoreTo: z.object({ version: z.string(), snapshotAt: z.number() }).exactOptional(),
});
export type HostStatus = z.infer<typeof HostStatus>;

/** How many things wait for the user on one host: its bots' open items plus its problems. The one formula the tray, the banner and the web badge share. */
export function needsYou(
  bots: readonly { readonly needsYou: number }[],
  status: HostStatus | undefined,
): number {
  return bots.reduce((sum, bot) => sum + bot.needsYou, 0) + (status?.problems.length ?? 0);
}

/** A host's status as a message on `/api/events`: sent to every page that connects, and again whenever it changes. */
export const HostStatusEvent = z.object({ type: z.literal("host-status"), status: HostStatus });
export type HostStatusEvent = z.infer<typeof HostStatusEvent>;
