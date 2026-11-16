import type { ServerResponse } from "node:http";

import {
  ChannelRequest,
  type ChannelLinkCodeResponse,
  type ChannelList,
} from "@claudebot/contract/api";

import { NotFound } from "../../platform/errors.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";

/** The `/api/channels/*` routes: list the channels with their links, create a link code and unlink a channel. */
export function channelApi(
  { channels }: ApiContext,
  res: ServerResponse,
  path: string,
  b: Record<string, unknown>,
) {
  try {
    switch (path) {
      case "/api/channels/list": {
        const body: ChannelList = channels.list();
        return json(res, body);
      }
      case "/api/channels/link-code": {
        const { channel } = ChannelRequest.parse(b);
        const body: ChannelLinkCodeResponse = { code: channels.createLinkCode(channel) };
        return json(res, body);
      }
      case "/api/channels/unlink": {
        const { channel } = ChannelRequest.parse(b);
        return json(res, { ok: channels.unlink(channel) });
      }
    }
    res.writeHead(404).end();
  } catch (e) {
    if (e instanceof NotFound) return json(res, { error: e.message }, 404);
    throw e;
  }
}
