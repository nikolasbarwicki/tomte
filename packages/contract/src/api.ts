// HTTP-only shapes: request vocabulary and response bodies no event stream carries. A shape that also rides
// an event stream (`Bot`, `Routine`, `Integration`, ...) lives in events.ts, whichever endpoint returns it.
import { z } from "zod";

/** The reasoning effort levels the host accepts at `/api/effort`; the Claude Agent SDK's `EffortLevel`. */
export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

/** Whether bots can get a browser on this host, and why not. */
export const BrowserAvailability = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), path: z.string(), source: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type BrowserAvailability = z.infer<typeof BrowserAvailability>;

/** The `/api/info` response: where the host runs and how it reaches Claude. */
export const HostInfo = z.object({
  cwd: z.string(),
  cli: z.string(),
  auth: z.string(),
  browser: BrowserAvailability,
});
export type HostInfo = z.infer<typeof HostInfo>;

/** The `/api/routines/preview` response: the next times the schedule fires. */
export const RoutinePreview = z.object({ next: z.array(z.number()) });
export type RoutinePreview = z.infer<typeof RoutinePreview>;

/** The `/api/integrations/connect-oauth` response: where the user signs in. */
export const OAuthStart = z.object({ authorizeUrl: z.string() });
export type OAuthStart = z.infer<typeof OAuthStart>;
