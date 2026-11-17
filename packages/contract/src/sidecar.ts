import { z } from "zod";

/** The one stdout line a host in sidecar mode writes once its client listener is up. The desktop app parses it to learn where to load the UI from. */
export const SidecarReady = z.object({
  type: z.literal("ready"),
  /** The client listener's loopback URL: the web UI and `/api/*`. */
  clientUrl: z.url(),
});
export type SidecarReady = z.infer<typeof SidecarReady>;

/** The launch token the desktop app writes to the sidecar's stdin: 32 random bytes as base64url, which is 43 characters. */
export const LaunchToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** What the Devices page calls the device a launch token registers. */
export const LAUNCH_DEVICE_NAME = "This computer";

/** The cookie that carries a device token for the browser UI; scripts send the same token as a bearer instead. */
export const SESSION_COOKIE = "tomte_session";
