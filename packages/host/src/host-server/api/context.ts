import type { Database } from "bun:sqlite";
import type { ServerResponse } from "node:http";

import type { HostEvent } from "@claudebot/contract/events";
import type { z } from "zod";

import type { Browser } from "../../browser/index.ts";
import type { Channels } from "../../channels/index.ts";
import type { Credentials } from "../../credentials/index.ts";
import type { DeviceAuth } from "../../device-auth/index.ts";
import type { Events as ExternalEvents } from "../../events/index.ts";
import type { ResolvedCli } from "../../harness/index.ts";
import type { Integrations } from "../../integrations/index.ts";
import type { Routines } from "../../routines/index.ts";
import type { Chats, OpenChat } from "../chats.ts";
import type { DeviceSessions } from "../device-sessions.ts";
import type { EventStream } from "../events.ts";

/** What the `/api/*` handlers call into. */
export interface ApiContext {
  /** The workspace directory the Claude CLI runs in. */
  cwd: string;
  /** Where bots, their memory and the user memory live. */
  dataRoot: string;
  /** Whether a bot may run headed Chrome; see `HostConfig.headedBrowser`. */
  headedBrowser: boolean;
  /** True while the bot has background tasks running or queued; changing its chat mode is refused then. */
  hasActiveTasks: (botId: string) => boolean;
  cli: ResolvedCli;
  db: Database;
  chats: Chats;
  /** Called after a bot is created, so sessions open before it pick up what depends on the set of bots. */
  botsChanged: () => void;
  /** Deletes a bot and everything the host holds for it; its directory goes to the trash. */
  removeBot: (botId: string) => Promise<void>;
  browser: Browser;
  routines: Routines;
  integrations: Integrations;
  credentials: Credentials;
  devices: DeviceAuth;
  channels: Channels;
  /** Which device each request came from, and the responses still open for it. */
  sessions: DeviceSessions;
  events: EventStream;
  /** External events and event tokens; `events` above is the page's own stream. */
  externalEvents: ExternalEvents;
  /** Shows a path in the OS file manager; absent when the host cannot (`config.reveal` is off), so no request can spawn one. */
  reveal: ((path: string, log: (line: string) => void) => void) | undefined;
  /** Everything a page receives when it connects. */
  snapshot(): HostEvent[];
}

/** A decoded `/api/*` request: its path, query string and JSON body. */
export interface ApiRequest {
  res: ServerResponse;
  path: string;
  query: URLSearchParams;
  /** The body parsed by `schema`; a mismatch throws a `ZodError`, which the API answers with 400. */
  parse: <T>(schema: z.ZodType<T>) => T;
}

export type ApiRoutes = Record<string, (r: ApiRequest) => Promise<void>>;
/** Routes that act on the chat the page shows. */
export type OpenChatRoutes = Record<string, (r: ApiRequest, chat: OpenChat) => Promise<void>>;
