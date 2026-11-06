import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

/** A status herdr adds later reads as `unknown`, which is never reported. */
const AgentStatus = z.enum(["idle", "working", "blocked", "done", "unknown"]).catch("unknown");
type AgentStatus = z.infer<typeof AgentStatus>;
const PaneList = z.object({
  panes: z.array(z.object({ pane_id: z.string(), cwd: z.string().optional() })),
});
const StatusChange = z.object({
  pane_id: z.string(),
  agent: z.string().nullish(),
  display_agent: z.string().nullish(),
  title: z.string().nullish(),
  agent_status: AgentStatus,
});
/** One line from the herdr socket: a reply (`result` or `error`) or a subscription event. */
const Message = z.object({
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.union([z.string(), z.number()]).optional() }).optional(),
  event: z.string().optional(),
  data: z.unknown().optional(),
});

/** A line from the herdr socket that is not the JSON herdr's protocol describes. */
class HerdrProtocolError extends Error {}

function parse<T>(schema: z.ZodType<T>, line: unknown): T {
  const parsed = schema.safeParse(line);
  if (!parsed.success) throw new HerdrProtocolError(z.prettifyError(parsed.error));
  return parsed.data;
}

function parseLine(line: string): z.infer<typeof Message> {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw new HerdrProtocolError("herdr sent a line that is not JSON");
  }
  return parse(Message, v);
}

/** Agent states worth telling the user about. */
const NOTIFY: Partial<Record<AgentStatus, string>> = { blocked: "needs input", done: "finished" };
const RETRY_MS = 5_000;

function socketPath(): string {
  return process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

/** One request/response round trip on a fresh connection. */
function request<T>(
  path: string,
  method: string,
  params: object,
  result: z.ZodType<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    sock.once("error", reject);
    sock.write(JSON.stringify({ id: method, method, params }) + "\n");
    createInterface({ input: sock }).once("line", (line) => {
      sock.destroy();
      try {
        const msg = parseLine(line);
        if (msg.error)
          reject(new Error(`${method}: ${String(msg.error.code ?? JSON.stringify(msg.error))}`));
        else resolve(parse(result, msg.result));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Watch herdr agent status for every pane and report blocked/done transitions.
 * Herdr status subscriptions are per pane, so any pane created/closed rebuilds the subscription.
 */
export function watchHerdr(
  notify: (title: string, body: string) => void,
  log: (l: string) => void,
): () => void {
  const path = socketPath();
  let sock: Socket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let warned = false;
  let generation = 0;
  const cwds = new Map<string, string>();

  const retry = () => {
    sock?.destroy();
    sock = undefined;
    if (!stopped && !timer) timer = setTimeout(() => ((timer = undefined), void start()), RETRY_MS);
  };

  async function start() {
    if (!existsSync(path)) {
      if (!warned) log(`herdr: no socket at ${path}; retrying`);
      warned = true;
      return retry();
    }
    try {
      const gen = ++generation;
      const { panes } = await request(path, "pane.list", {}, PaneList);
      if (gen !== generation || stopped) return;
      cwds.clear();
      for (const p of panes) if (p.cwd) cwds.set(p.pane_id, p.cwd);
      sock?.destroy();
      const s = (sock = connect(path));
      s.on("error", (e) => log(`herdr: ${e.message}`));
      s.on("close", () => sock === s && retry());
      s.write(
        JSON.stringify({
          id: "claudebot",
          method: "events.subscribe",
          params: {
            subscriptions: [
              { type: "pane.created" },
              { type: "pane.closed" },
              ...panes.map((p) => ({ type: "pane.agent_status_changed", pane_id: p.pane_id })),
            ],
          },
        }) + "\n",
      );
      createInterface({ input: s }).on("line", (line) => {
        let msg: z.infer<typeof Message>;
        let d: z.infer<typeof StatusChange> | undefined;
        try {
          msg = parseLine(line);
          if (msg.event === "pane.agent_status_changed") d = parse(StatusChange, msg.data);
        } catch (e) {
          if (!(e instanceof HerdrProtocolError)) throw e;
          log(`herdr: ${e.message}`);
          return retry();
        }
        if (msg.error) {
          log(`herdr: subscription ${String(msg.error.code)}`);
          retry();
          return;
        }
        if (msg.result) return void (warned = false);
        if (msg.event && /^pane[._](created|closed)$/.test(msg.event)) {
          sock = undefined;
          s.destroy();
          return void start();
        }
        if (!d) return;
        const what = NOTIFY[d.agent_status];
        if (!what || !d.agent) return;
        const where = cwds.get(d.pane_id);
        notify(
          `${d.display_agent ?? d.agent} ${what}`,
          [d.title, d.pane_id, where].filter(Boolean).join(" · "),
        );
      });
    } catch (e) {
      log(`herdr: ${(e as Error).message}`);
      retry();
    }
  }

  void start();
  return () => {
    stopped = true;
    clearTimeout(timer);
    sock?.destroy();
  };
}
