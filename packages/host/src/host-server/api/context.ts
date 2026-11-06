import type { Database } from "bun:sqlite";
import type { ServerResponse } from "node:http";

import type { Browser } from "../../browser/index.ts";
import type { Credentials } from "../../credentials/index.ts";
import type { ResolvedCli } from "../../harness/index.ts";
import type { Integrations } from "../../integrations/index.ts";
import type { Routines } from "../../routines/index.ts";
import type { Chats, OpenChat } from "../chats.ts";
import type { EventStream, HostEvent } from "../events.ts";

/** What the `/api/*` handlers call into. */
export interface ApiContext {
  /** The workspace directory the Claude CLI runs in. */
  cwd: string;
  /** Where bots, their memory and the user memory live. */
  dataRoot: string;
  cli: ResolvedCli;
  db: Database;
  chats: Chats;
  browser: Browser;
  routines: Routines;
  integrations: Integrations;
  credentials: Credentials;
  events: EventStream;
  /** Everything a page receives when it connects. */
  snapshot(): HostEvent[];
}

/** A decoded `/api/*` request: its path and JSON body. */
export interface ApiRequest {
  res: ServerResponse;
  path: string;
  body: Record<string, unknown>;
  /** A string field of the body; "" when missing or not a string. */
  str(key: string): string;
}

export type ApiRoutes = Record<string, (r: ApiRequest) => Promise<void>>;
/** Routes that act on the chat the page shows. */
export type OpenChatRoutes = Record<string, (r: ApiRequest, chat: OpenChat) => Promise<void>>;
