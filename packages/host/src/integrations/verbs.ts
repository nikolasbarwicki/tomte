import type { ToolPolicy } from "@tomte/contract/events";

/**
 * What a built-in integration's tool does to the owner's data. The class is the one thing a tool's definition states about its
 * risk: the default policy, the annotations the Integrations screen shows and whether the tool is locked all follow from it.
 */
export type VerbClass = "read" | "draft" | "organize" | "delete" | "send";

interface VerbRules {
  /** The policy a fresh connection gives the tool. */
  policy: ToolPolicy;
  readOnly: boolean;
  destructive: boolean;
  /** A locked tool always asks: its policy can be Ask or Off, an always-allow rule never skips its approval. */
  locked: boolean;
}

export const VERBS: Record<VerbClass, VerbRules> = {
  read: { policy: "auto", readOnly: true, destructive: false, locked: false },
  draft: { policy: "ask", readOnly: false, destructive: false, locked: false },
  organize: { policy: "ask", readOnly: false, destructive: false, locked: false },
  delete: { policy: "ask", readOnly: false, destructive: true, locked: false },
  send: { policy: "ask", readOnly: false, destructive: true, locked: true },
};
