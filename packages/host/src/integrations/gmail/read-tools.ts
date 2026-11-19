import { z } from "zod";

import { renderThread, threadLine, wrapMail } from "./mail-text.ts";
import { gmailTool } from "./tool.ts";
import { Thread, ThreadList } from "./wire.ts";

const threadPath = (id: string) => `threads/${encodeURIComponent(id)}`;

const searchThreads = gmailTool({
  name: "search_threads",
  description:
    "Search the mailbox with Gmail's search syntax (for example `from:anna newer_than:7d is:unread`) and list the matching threads, newest first: id, message count, latest sender and date, subject and a snippet. Use get_thread to read one.",
  verb: "read",
  input: {
    query: z
      .string()
      .optional()
      .describe("Gmail search query; leave empty to list the newest threads"),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe("How many threads, 10 by default"),
    page_token: z.string().optional().describe("The next_page_token of the previous page"),
  },
  async run(api, { query, max_results, page_token }) {
    const list = ThreadList.parse(
      await api.call("threads.list", {
        path: "threads",
        query: { q: query, maxResults: max_results ?? 10, pageToken: page_token },
      }),
    );
    if (!list.threads?.length) return "No threads found.";
    const threads = await Promise.all(
      list.threads.map(async ({ id }) =>
        Thread.parse(
          await api.call(
            "threads.get",
            {
              path: threadPath(id),
              query: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] },
            },
            id,
          ),
        ),
      ),
    );
    const found = wrapMail(threads.map(threadLine).join("\n\n"));
    return list.nextPageToken ? `${found}\nnext_page_token: ${list.nextPageToken}` : found;
  },
});

const getThread = gmailTool({
  name: "get_thread",
  description:
    "Read a thread as plain text: every message with sender, recipients, date, subject and body. HTML is converted to text and a long body is cut with a note saying how much was left out.",
  verb: "read",
  input: { thread_id: z.string().describe("A thread id from search_threads") },
  async run(api, { thread_id }) {
    return renderThread(
      Thread.parse(
        await api.call(
          "threads.get",
          { path: threadPath(thread_id), query: { format: "full" } },
          thread_id,
        ),
      ),
    );
  },
});

export const READ_TOOLS = [searchThreads, getThread];
