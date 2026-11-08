// HTTP-only shapes: request vocabulary and response bodies no event stream carries. A shape that also rides
// an event stream (`Bot`, `Routine`, `Integration`, ...) lives in events.ts, whichever endpoint returns it.
import { z } from "zod";

/** The reasoning effort levels the host accepts at `/api/effort`; the Claude Agent SDK's `EffortLevel`. */
export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

/** The model and effort a session opens with until the user picks others. */
export const DEFAULT_MODEL = "sonnet";
export const DEFAULT_EFFORT: EffortLevel = "medium";

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
