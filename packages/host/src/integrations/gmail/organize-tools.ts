import { z } from "zod";

import type { GmailApi } from "./client.ts";
import { oneLine } from "./mail-text.ts";
import { gmailTool, ToolInputError } from "./tool.ts";

const LabelList = z.object({
  labels: z
    .array(z.object({ id: z.string(), name: z.string(), type: z.string().optional() }))
    .optional(),
});

async function labelsOf(api: GmailApi) {
  const list = LabelList.parse(await api.call("labels.list", { path: "labels" }));
  return list.labels ?? [];
}

const listLabels = gmailTool({
  name: "list_labels",
  description:
    "List the mailbox's labels, system ones (INBOX, UNREAD, STARRED…) and the owner's own, with their ids. modify_labels takes either the name or the id.",
  verb: "read",
  input: {},
  async run(api) {
    const labels = await labelsOf(api);
    if (labels.length === 0) return "No labels.";
    return labels
      .map((l) => `- ${oneLine(l.name)} | id=${l.id} | ${l.type === "system" ? "system" : "user"}`)
      .join("\n");
  },
});

const modifyLabels = gmailTool({
  name: "modify_labels",
  description:
    "Add or remove labels on a whole thread or on one message. Archive a thread by removing INBOX; mark it read by removing UNREAD. Labels are given by name or id (see list_labels). Moving mail to the trash is trash_thread, not a label.",
  verb: "organize",
  input: {
    thread_id: z.string().optional().describe("The thread to change (give this or message_id)"),
    message_id: z
      .string()
      .optional()
      .describe("The single message to change (give this or thread_id)"),
    add_labels: z.array(z.string()).max(20).optional().describe("Labels to add, by name or id"),
    remove_labels: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("Labels to remove, by name or id"),
  },
  async run(api, { thread_id, message_id, add_labels = [], remove_labels = [] }) {
    if ((thread_id === undefined) === (message_id === undefined))
      throw new ToolInputError("give exactly one of thread_id and message_id");
    if (add_labels.length + remove_labels.length === 0)
      throw new ToolInputError("give at least one label to add or remove");
    const labels = await labelsOf(api);
    const resolve = (given: string) => {
      const want = given.trim().toLowerCase();
      const found = labels.find(
        (l) => l.id.toLowerCase() === want || l.name.toLowerCase() === want,
      );
      if (!found) throw new ToolInputError(`no label named "${given}"; see list_labels`);
      return found.id;
    };
    const add = add_labels.map(resolve);
    const remove = remove_labels.map(resolve);
    if (add.includes("TRASH"))
      throw new ToolInputError("moving mail to the trash is trash_thread, not a label");
    const [kind, id] =
      thread_id !== undefined
        ? (["threads", thread_id] as const)
        : (["messages", message_id ?? ""] as const);
    await api.call(
      `${kind}.modify`,
      {
        path: `${kind}/${encodeURIComponent(id)}/modify`,
        method: "POST",
        body: { addLabelIds: add, removeLabelIds: remove },
      },
      id,
    );
    const changes = [
      ...(add.length ? [`added ${add.join(", ")}`] : []),
      ...(remove.length ? [`removed ${remove.join(", ")}`] : []),
    ];
    return `${kind === "threads" ? "Thread" : "Message"} ${id}: ${changes.join("; ")}.`;
  },
});

const trashThread = gmailTool({
  name: "trash_thread",
  description:
    "Move a whole thread to the trash. Gmail empties the trash after 30 days, and the owner can restore it until then. There is no permanent delete.",
  verb: "delete",
  input: { thread_id: z.string().describe("The thread to move to the trash") },
  async run(api, { thread_id }) {
    await api.call(
      "threads.trash",
      { path: `threads/${encodeURIComponent(thread_id)}/trash`, method: "POST" },
      thread_id,
    );
    return `Thread ${thread_id} moved to the trash.`;
  },
});

export const ORGANIZE_TOOLS = [listLabels, modifyLabels, trashThread];
