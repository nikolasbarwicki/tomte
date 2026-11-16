import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HandoffHost } from "./test-host.ts";

export interface SessionLine {
  role: "user" | "assistant";
  text: string;
  /** When the message was written, in epoch milliseconds; one second apart from 1_700_000_000_000 when omitted. */
  at?: number;
  extra?: Record<string, unknown>;
}

/**
 * Writes a bot's Claude Code session file as the real CLI would have, one line per message. It goes under the CLAUDE_CONFIG_DIR
 * of the process, which is where the host reads sessions from; the fake CLI writes none. `sessionId` is the bot's id, its first
 * session, unless a later session is meant.
 */
export function writeSession(
  host: Pick<HandoffHost, "cwd">,
  botId: string,
  lines: SessionLine[],
  sessionId = botId,
) {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR!,
    "projects",
    host.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  mkdirSync(dir, { recursive: true });
  const rows = lines.map((m, i) => ({
    uuid: `${sessionId}-${i}`,
    parentUuid: i ? `${sessionId}-${i - 1}` : null,
    sessionId,
    timestamp: new Date(m.at ?? 1_700_000_000_000 + i * 1000).toISOString(),
    cwd: host.cwd,
    isSidechain: false,
    type: m.role,
    message:
      m.role === "user"
        ? { role: "user", content: m.text }
        : { role: "assistant", content: [{ type: "text", text: m.text }] },
    ...m.extra,
  }));
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    rows.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}
