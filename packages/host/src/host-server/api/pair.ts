import { PairingRequest, type PairingResponse } from "@tomte/contract/api";

import type { DeviceAuth } from "../../device-auth/index.ts";
import { InvalidBody, readJsonObject } from "../../platform/json-body.ts";
import { json, type Handler } from "../http.ts";
import { sessionCookie } from "../session-cookie.ts";

/**
 * The pairing exchange: a pairing code and a device name for a new device token, returned in the body for
 * scripts and set as the session cookie for browsers. A wrong code answers 401 and says no more than that.
 */
export function pairRoute(devices: DeviceAuth, publicUrl: string): Handler {
  return async (req, res) => {
    let request: PairingRequest;
    try {
      const parsed = PairingRequest.safeParse(await readJsonObject(req));
      if (!parsed.success) return json(res, { error: "code and name are required" }, 400);
      request = parsed.data;
    } catch (e) {
      if (e instanceof InvalidBody) return json(res, { error: e.message }, 400);
      throw e;
    }
    const paired = devices.pair(request.code, request.name);
    if (!paired) return json(res, { error: "invalid pairing code" }, 401);
    const body: PairingResponse = paired;
    res
      .writeHead(200, {
        "content-type": "application/json",
        "set-cookie": sessionCookie(paired.token, publicUrl),
      })
      .end(JSON.stringify(body));
  };
}
