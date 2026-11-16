import type { ServerResponse } from "node:http";

import {
  ChannelRequest,
  ChannelTokenRequest,
  type ChannelLinkCodeResponse,
  type ChannelList,
} from "@claudebot/contract/api";

import { NotFound } from "../../platform/errors.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";

/**
 * The `/api/channels/*` routes: list the channels with their links and status, create a link code, unlink a channel and set Telegram's bot token.
 * The token is checked with Telegram before it is stored and is never in a response.
 */
export async function channelApi(
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
        const code = channels.createLinkCode(channel);
        const body: ChannelLinkCodeResponse = {
          code,
          url: channels.linkUrl(channel, code) ?? null,
        };
        return json(res, body);
      }
      case "/api/channels/unlink": {
        const { channel } = ChannelRequest.parse(b);
        return json(res, { ok: channels.unlink(channel) });
      }
      case "/api/channels/telegram/token": {
        const { token } = ChannelTokenRequest.parse(b);
        const outcome = await channels.setToken("telegram", token);
        if (outcome.ok) return json(res, { ok: true });
        return outcome.reason === "rejected"
          ? json(res, { error: "Telegram rejected this bot token" }, 400)
          : json(res, { error: "could not reach Telegram to check the bot token" }, 502);
      }
    }
    res.writeHead(404).end();
  } catch (e) {
    if (e instanceof NotFound) return json(res, { error: e.message }, 404);
    throw e;
  }
}
