import type { Bot, MemoryScope } from "@claudebot/contract/events";

import { frontContext, type HostDelegate, type ThreadEnv } from "../bots/index.ts";
import { FrontSession, type FrontOptions } from "./front.ts";

export { FrontSession } from "./front.ts";
export { withoutWorkState } from "./work-state.ts";

/** Opens a bot's front session in the host's shared thread environment, whose `hostServers` is the lease the front may use. */
export function openFront(
  { cwd, dataRoot, cli, claude, hostServers, botEnv, approveAll }: ThreadEnv,
  bot: Bot,
  opts: {
    resume: boolean;
    delegate: HostDelegate;
    idleMs?: number;
    log: (line: string) => void;
    onMemory?: (scope: MemoryScope, text: string) => void;
    onMessage: FrontOptions["onMessage"];
    onEnd: FrontOptions["onEnd"];
  },
): FrontSession {
  const { sessionId, persona, memory } = frontContext(dataRoot, bot);
  if (sessionId === undefined) throw new Error(`bot ${bot.id} has no session`);
  return new FrontSession({
    cli,
    claude,
    cwd,
    sessionId,
    hostServers: () => hostServers(bot.id),
    env: () => botEnv(bot.id),
    approveAll,
    persona,
    memory,
    ...opts,
  });
}
