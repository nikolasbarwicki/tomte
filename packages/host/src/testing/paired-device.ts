import type { HostServer } from "../host-server/index.ts";
import { defined } from "./defined.ts";

/** Pairs a device with the host the way `host pair` and the pairing exchange do, and returns its device token. */
export function pairDevice(server: HostServer, name = "test device"): string {
  const paired = server.devices.pair(server.devices.createPairingCode(), name);
  return defined(paired, "paired device").token;
}

/** The headers of a client listener request from a paired device, as a script sends them. */
export const asDevice = (token: string) => ({ authorization: `Bearer ${token}` });

/** A POST to a client listener route as the web page sends it from a paired device: the host's own Origin, a JSON body and the device token. */
export const clientPost = (server: HostServer, token: string, path: string, body: object) =>
  fetch(`${server.clientUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.clientUrl, ...asDevice(token) },
    body: JSON.stringify(body),
  });
