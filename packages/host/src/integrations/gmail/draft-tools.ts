import { z } from "zod";

import { composeMessage, COMPOSE_INPUT } from "./compose.ts";
import { draftLine, wrapMail } from "./mail-text.ts";
import { gmailTool } from "./tool.ts";
import { Message } from "./wire.ts";

const DraftRef = z.object({
  id: z.string(),
  message: z.object({ threadId: z.string().optional() }).optional(),
});
const DraftList = z.object({
  drafts: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});
const Draft = z.object({ id: z.string(), message: Message.optional() });

const draftPath = (id: string) => `drafts/${encodeURIComponent(id)}`;

const listDrafts = gmailTool({
  name: "list_drafts",
  description:
    "List the owner's drafts: id, the message and thread it belongs to, recipient, subject and a snippet. Use get_thread with the thread id to read one.",
  verb: "read",
  input: {
    query: z.string().optional().describe("Gmail search query to narrow the drafts"),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe("How many drafts, 10 by default"),
    page_token: z.string().optional().describe("The next_page_token of the previous page"),
  },
  async run(api, { query, max_results, page_token }) {
    const list = DraftList.parse(
      await api.call("drafts.list", {
        path: "drafts",
        query: { q: query, maxResults: max_results ?? 10, pageToken: page_token },
      }),
    );
    if (!list.drafts?.length) return "No drafts found.";
    const drafts = await Promise.all(
      list.drafts.map(async ({ id }) =>
        Draft.parse(
          await api.call(
            "drafts.get",
            {
              path: draftPath(id),
              query: { format: "metadata", metadataHeaders: ["To", "Subject"] },
            },
            id,
          ),
        ),
      ),
    );
    const found = wrapMail(
      drafts.flatMap((d) => (d.message ? [draftLine(d.id, d.message)] : [])).join("\n\n"),
    );
    return list.nextPageToken ? `${found}\nnext_page_token: ${list.nextPageToken}` : found;
  },
});

const createDraft = gmailTool({
  name: "create_draft",
  description:
    "Save a draft in the owner's Drafts; nothing is sent. Give thread_id to prepare a reply in that thread. The owner reviews and sends it from Gmail.",
  verb: "draft",
  input: COMPOSE_INPUT,
  async run(api, input) {
    const { raw, threadId } = await composeMessage(api, input);
    const draft = DraftRef.parse(
      await api.call("drafts.create", {
        path: "drafts",
        method: "POST",
        body: { message: { raw, ...(threadId !== undefined && { threadId }) } },
      }),
    );
    return `Draft ${draft.id} saved${draft.message?.threadId ? ` in thread ${draft.message.threadId}` : ""}. Nothing was sent.`;
  },
});

const updateDraft = gmailTool({
  name: "update_draft",
  description:
    "Replace the content of an existing draft; nothing is sent. The whole draft is rewritten, so give every field again, recipients included. Give thread_id to keep it a reply in that thread.",
  verb: "draft",
  input: {
    draft_id: z.string().describe("A draft id from list_drafts or create_draft"),
    ...COMPOSE_INPUT,
  },
  async run(api, { draft_id, ...input }) {
    const { raw, threadId } = await composeMessage(api, input);
    const draft = DraftRef.parse(
      await api.call(
        "drafts.update",
        {
          path: draftPath(draft_id),
          method: "PUT",
          body: { id: draft_id, message: { raw, ...(threadId !== undefined && { threadId }) } },
        },
        draft_id,
      ),
    );
    return `Draft ${draft.id} updated. Nothing was sent.`;
  },
});

export const DRAFT_TOOLS = [listDrafts, createDraft, updateDraft];
