import { DeviceList, PairingCodeResponse } from "@claudebot/contract/api";

import { act, errorOf, post, readJson } from "@/host/api.ts";

/** The paired devices; throws the host's error message when the request fails. */
export async function listDevices(): Promise<DeviceList> {
  const res = await post("/api/devices/list", {});
  if (!res.ok) throw new Error(await errorOf(res));
  return readJson(res, DeviceList);
}

/** A new single-use pairing code; throws the host's error message when the request fails. */
export async function createPairingCode(): Promise<string> {
  const res = await post("/api/devices/pairing-code", {});
  if (!res.ok) throw new Error(await errorOf(res));
  return (await readJson(res, PairingCodeResponse)).code;
}

export const revokeDevice = (id: string) => act("/api/devices/revoke", { id });
