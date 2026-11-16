// HTTP-only shapes: request vocabulary and response bodies no event stream carries. A shape that also rides
// an event stream (`Bot`, `Routine`, `Integration`, ...) lives in events.ts, whichever endpoint returns it.
import { z } from "zod";

import { EventSource, ExternalEventKind, WorkSnapshot } from "./events.ts";

/** Whether bots can get a browser on this host, and why not. */
export const BrowserAvailability = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), path: z.string(), source: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type BrowserAvailability = z.infer<typeof BrowserAvailability>;

/** The `/api/info` response: where the host runs and which Claude CLI it uses. */
export const HostInfo = z.object({
  cwd: z.string(),
  cli: z.string(),
  browser: BrowserAvailability,
});
export type HostInfo = z.infer<typeof HostInfo>;

/** The version of the `/api/*` surface a client talks to; the host-info route reports it. */
export const API_VERSION = 1;

/** Whether the Claude CLI holds a sign-in. `unknown`: `auth status` could not run or its output did not parse. */
export const ClaudeSignIn = z.enum(["signed-in", "signed-out", "unknown"]);
export type ClaudeSignIn = z.infer<typeof ClaudeSignIn>;

/**
 * The `/api/host-info` response, which needs no device token: what this host is and what it can do, so the UI hides
 * actions it cannot perform. `claude` is present in remote mode only. It carries no other host state.
 */
export const PublicHostInfo = z.object({
  version: z.string(),
  apiVersion: z.number().int(),
  mode: z.enum(["local", "remote"]),
  claude: ClaudeSignIn.optional(),
  capabilities: z.object({
    reveal: z.boolean(),
    headedBrowser: z.boolean(),
    browserSandbox: z.boolean(),
  }),
});
export type PublicHostInfo = z.infer<typeof PublicHostInfo>;

/** The `/api/routines/preview` response: the next times the schedule fires. */
export const RoutinePreview = z.object({ next: z.array(z.number()) });
export type RoutinePreview = z.infer<typeof RoutinePreview>;

/** The `/api/integrations/connect-oauth` response: where the user signs in. */
export const OAuthStart = z.object({ authorizeUrl: z.string() });
export type OAuthStart = z.infer<typeof OAuthStart>;

/** The `/api/pair` request: a pairing code from `host pair` and the name the new device will show. */
export const PairingRequest = z.object({
  code: z.string().min(1),
  name: z.string().trim().min(1).max(100),
});
export type PairingRequest = z.infer<typeof PairingRequest>;

/** The `/api/pair` response: the new device and its device token, which is shown only here. */
export const PairingResponse = z.object({ deviceId: z.string(), token: z.string() });
export type PairingResponse = z.infer<typeof PairingResponse>;

/** A paired device in the `/api/devices/list` response. `current` marks the device that made the request. */
export const DeviceEntry = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  current: z.boolean(),
});
export type DeviceEntry = z.infer<typeof DeviceEntry>;

/** The `/api/devices/list` response: every paired device, oldest first. */
export const DeviceList = z.array(DeviceEntry);
export type DeviceList = z.infer<typeof DeviceList>;

/** The `/api/devices/revoke` request. */
export const RevokeDeviceRequest = z.object({ id: z.string().min(1) });
export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequest>;

/** The `/api/devices/pairing-code` response: a new single-use code, in groups of four, which is shown only here. */
export const PairingCodeResponse = z.object({ code: z.string() });
export type PairingCodeResponse = z.infer<typeof PairingCodeResponse>;

/** The largest `/api/bots/<botId>/events` request body in bytes; a larger one gets 413. */
export const MAX_EVENT_BODY_BYTES = 64 * 1024;

/**
 * A name that is safe to place in a program's argument list as an element of its own: letters, digits and `. _ : -`,
 * 1 to 128 characters, not starting with `-` so it can never read as an option. Question ids, agents and sessions are these.
 */
export const SlotName = z
  .string()
  .regex(
    /^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,127}$/,
    "letters, digits and . _ : - only, 1 to 128 characters, not starting with -",
  );

/**
 * Where the answer to an event should go: `kind` names a relay adapter in the host's trusted configuration (ADR-0008),
 * `agent` and `session` fill its slots. It names no command, argument or environment, and no other key is accepted.
 */
export const ReplyTarget = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "a lowercase name of up to 32 characters"),
    agent: SlotName,
    session: SlotName.optional(),
  })
  .strict();
export type ReplyTarget = z.infer<typeof ReplyTarget>;

/**
 * The `/api/bots/<botId>/events` request: one external event. `key` dedupes per bot, so a retried post reaches the
 * bot once. `options` are suggested answers to a `question`. `resolves` names keys of this source's open events to
 * close. `work` replaces the source's work snapshot. `questionId` is the sender's id for the question; `reply` is where
 * the user's answer is relayed to, when the host's operator configured a relay for its kind.
 */
export const ExternalEventInput = z
  .object({
    kind: ExternalEventKind,
    key: z.string().min(1).max(200),
    source: EventSource,
    title: z.string().max(200),
    body: z.string().max(8192).optional(),
    options: z.array(z.string().min(1).max(200)).max(6).optional(),
    resolves: z.array(z.string().min(1).max(200)).max(50).optional(),
    work: WorkSnapshot.optional(),
    questionId: SlotName.optional(),
    reply: ReplyTarget.optional(),
  })
  .refine((e) => e.options === undefined || e.kind === "question", {
    path: ["options"],
    message: "only a question carries options",
  });
export type ExternalEventInput = z.infer<typeof ExternalEventInput>;

/** The events route's answer: 202 with `duplicate: false` for a new event, 200 with `duplicate: true` for a key already seen. */
export const ExternalEventPosted = z.object({ id: z.string(), duplicate: z.boolean() });
export type ExternalEventPosted = z.infer<typeof ExternalEventPosted>;

/** The `/api/bots/events-token` and `/api/bots/events-token/rotate` request. */
export const EventTokenRequest = z.object({ botId: z.string().min(1) });
export type EventTokenRequest = z.infer<typeof EventTokenRequest>;

/** The `/api/bots/events/archive` request: one of the bot's event sources, by the id its events name. */
export const ArchiveSourceRequest = z.object({
  botId: z.string().min(1),
  sourceId: z.string().min(1),
});
export type ArchiveSourceRequest = z.infer<typeof ArchiveSourceRequest>;

/** The `/api/bots/events/dismiss` and `/api/bots/events/relay/retry` requests: one needs-you item of a bot, by its event id. */
export const EventItemRequest = z.object({ botId: z.string().min(1), id: z.string().min(1) });
export type EventItemRequest = z.infer<typeof EventItemRequest>;

/** How an external process posts to one bot: the events route's URL and the bot's event token. */
export const EventAccess = z.object({ url: z.string(), token: z.string() });
export type EventAccess = z.infer<typeof EventAccess>;
