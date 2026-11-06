import type { IncomingMessage, ServerResponse } from "node:http";

import {
  RevokeDeviceRequest,
  type DeviceList,
  type PairingCodeResponse,
} from "@claudebot/contract/api";

import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";

/**
 * The `/api/devices/*` routes: list the paired devices, create a pairing code and revoke a device. Revoking
 * answers first and then ends the device's open responses, so a device that revokes itself still gets its answer.
 */
export function deviceApi(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  b: Record<string, unknown>,
) {
  switch (path) {
    case "/api/devices/list": {
      const self = ctx.sessions.deviceOf(req);
      const body: DeviceList = ctx.devices.list().map((d) => ({ ...d, current: d.id === self }));
      return json(res, body);
    }
    case "/api/devices/pairing-code": {
      const body: PairingCodeResponse = { code: ctx.devices.createPairingCode() };
      return json(res, body);
    }
    case "/api/devices/revoke": {
      const { id } = RevokeDeviceRequest.parse(b);
      if (!ctx.devices.revoke(id)) return json(res, { error: "no such device" }, 404);
      json(res, { ok: true });
      ctx.sessions.close(id);
      return;
    }
  }
  res.writeHead(404).end();
}
