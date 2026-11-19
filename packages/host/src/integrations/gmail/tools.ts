import { ATTACHMENT_TOOLS } from "./attachment-tools.ts";
import { DRAFT_TOOLS } from "./draft-tools.ts";
import { ORGANIZE_TOOLS } from "./organize-tools.ts";
import { READ_TOOLS } from "./read-tools.ts";
import { SEND_TOOLS } from "./send-tools.ts";
import type { GmailTool } from "./tool.ts";

/** Every tool of the built-in Gmail server, one group per line. This list is the server's definition: names, verb classes and locks come from it. */
export const GMAIL_TOOLS: readonly GmailTool[] = [
  ...READ_TOOLS,
  ...ORGANIZE_TOOLS,
  ...DRAFT_TOOLS,
  ...ATTACHMENT_TOOLS,
  ...SEND_TOOLS,
];
