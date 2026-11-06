import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Which paired device each request to the client listener came from, and which responses are still open for it.
 * Revoking a device ends every one of them, so its event stream and live view stop at once instead of running
 * until the page closes.
 */
export interface DeviceSessions {
  /** Records that `req` came from `deviceId` and keeps `res` until it closes. */
  open(deviceId: string, req: IncomingMessage, res: ServerResponse): void;
  /** The device a request that passed the boundary came from. Throws for one that did not: no handler runs for it. */
  deviceOf(req: IncomingMessage): string;
  /** Ends every response still open for the device; the response being written right now is left to finish. */
  close(deviceId: string): void;
}

export function createDeviceSessions(): DeviceSessions {
  const devices = new WeakMap<IncomingMessage, string>();
  const open = new Map<string, Set<ServerResponse>>();
  return {
    open(deviceId, req, res) {
      devices.set(req, deviceId);
      const responses = open.get(deviceId) ?? new Set();
      open.set(deviceId, responses);
      responses.add(res);
      res.on("close", () => {
        responses.delete(res);
        if (responses.size === 0 && open.get(deviceId) === responses) open.delete(deviceId);
      });
    },
    deviceOf(req) {
      const id = devices.get(req);
      if (id === undefined) throw new Error("request did not pass the device check");
      return id;
    },
    close(deviceId) {
      for (const res of open.get(deviceId) ?? []) if (!res.writableEnded) res.end();
    },
  };
}
