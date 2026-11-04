export type ServerEvent =
  | { type: "user"; text: string }
  | { type: "text_start" }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; input: string }
  | { type: "ask"; id: string; question: string }
  | { type: "approve"; id: string; tool: string; reason: string; input: string }
  | { type: "answered"; id: string; value: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "info"; text: string }
  | { type: "update"; text: string }
  | { type: "reset"; sessionId: string }
  | Notice;

/** External update from herdr or an omp hook; lives outside chat history. */
export type Notice = { type: "notify"; source: string; title: string; body: string; at: number };

export type ChatSummary = { sessionId: string; title: string; lastModified: number };
