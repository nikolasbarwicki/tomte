import { z } from "zod";

import { COMPOSE_INPUT, composeMessage } from "./compose.ts";
import { DraftContent, draftContent, sameDraft } from "./draft-content.ts";
import { gmailTool, ToolInputError } from "./tool.ts";

/** What `messages.send` and `drafts.send` answer: the sent message's id and thread. */
const Sent = z.object({ id: z.string(), threadId: z.string().optional() });

const MESSAGE_FIELDS = ["to", "cc", "bcc", "subject", "body", "thread_id"] as const;

/** A draft is sent as it stands, so no field of a message goes with its id. */
function onlyDraft(message: Partial<Record<(typeof MESSAGE_FIELDS)[number], unknown>>) {
  const extra = MESSAGE_FIELDS.filter((f) => message[f] !== undefined);
  if (extra.length)
    throw new ToolInputError(
      `draft_id sends the draft as it stands: leave out ${extra.join(", ")}, or send a new message without draft_id`,
    );
}

const sendMessage = gmailTool({
  name: "send_message",
  description:
    "Send an email from the owner's mailbox. The owner is asked to approve every send and sees exactly the recipients, subject, thread and body you give here; they approve that input and nothing else, so put everything in these fields. Three ways: a new message (to, subject, body, and cc or bcc if needed); a reply in a thread (the same fields plus thread_id; the reply is attached to the thread's latest message); or an existing draft (only draft_id, sent as the draft stands; the owner sees the draft's recipients, subject and body when they approve, and it is not sent if it changed since). The body is plain text.",
  verb: "send",
  input: {
    ...COMPOSE_INPUT,
    to: COMPOSE_INPUT.to.optional(),
    // The approval shows the input as given, so the subject and the body are always stated here, never derived.
    subject: z.string().max(998).optional().describe("The subject line; required for a message"),
    body: COMPOSE_INPUT.body.optional(),
    draft_id: z
      .string()
      .optional()
      .describe("A draft id from list_drafts: sends that draft as it stands, with no other field"),
    expected: DraftContent.optional().describe(
      "Filled in by Tomte with the draft the owner approved; always leave it out",
    ),
  },
  async prepareApproval(api, { expected: _ignored, ...input }) {
    if (input.draft_id === undefined) return input;
    const { draft_id, ...message } = input;
    onlyDraft(message);
    return { draft_id, expected: await draftContent(api, draft_id) };
  },
  async run(api, { draft_id, expected, ...message }) {
    if (draft_id !== undefined) {
      onlyDraft(message);
      if (!expected)
        throw new ToolInputError(
          "the owner has not seen this draft; call send_message with draft_id alone so they can approve it",
        );
      if (!sameDraft(expected, await draftContent(api, draft_id)))
        throw new ToolInputError(
          `draft ${draft_id} changed after the owner approved it, so it was not sent; call send_message again so they can approve it as it now stands`,
        );
      const sent = Sent.parse(
        await api.call(
          "drafts.send",
          { path: "drafts/send", method: "POST", body: { id: draft_id } },
          draft_id,
        ),
      );
      return `Sent draft ${draft_id} as message ${sent.id}${sent.threadId ? ` in thread ${sent.threadId}` : ""}.`;
    }
    const { to, subject, body } = message;
    if (!to?.length || subject === undefined || body === undefined)
      throw new ToolInputError(
        "a message needs to, subject and body (or a draft_id to send a draft)",
      );
    const { raw, threadId } = await composeMessage(api, { ...message, to, subject, body });
    const sent = Sent.parse(
      await api.call("messages.send", {
        path: "messages/send",
        method: "POST",
        body: { raw, ...(threadId !== undefined && { threadId }) },
      }),
    );
    return `Sent message ${sent.id}${sent.threadId ? ` in thread ${sent.threadId}` : ""}.`;
  },
});

export const SEND_TOOLS = [sendMessage];
