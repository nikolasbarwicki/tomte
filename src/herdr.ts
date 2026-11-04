import { connect, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
type Pane = { pane_id: string; agent?: string | null; cwd?: string };
type StatusChange = { pane_id: string; agent?: string | null; display_agent?: string | null; title?: string | null; agent_status: AgentStatus };

/** Agent states worth telling the user about. */
const NOTIFY: Partial<Record<AgentStatus, string>> = { blocked: "needs input", done: "finished" };
const RETRY_MS = 5_000;

export function socketPath(): string {
  return process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

/** One request/response round trip on a fresh connection. */
function request<T>(path: string, method: string, params: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    sock.once("error", reject);
    sock.write(JSON.stringify({ id: method, method, params }) + "\n");
    createInterface({ input: sock }).once("line", (line) => {
      sock.destroy();
      const msg = JSON.parse(line);
      msg.error ? reject(new Error(`${method}: ${msg.error.code ?? JSON.stringify(msg.error)}`)) : resolve(msg.result);
    });
  });
}

/**
 * Watch herdr agent status for every pane and report blocked/done transitions.
 * Herdr status subscriptions are per pane, so any pane created/closed rebuilds the subscription.
 */
export function watchHerdr(notify: (title: string, body: string) => void, log: (l: string) => void): () => void {
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
      const { panes } = await request<{ panes: Pane[] }>(path, "pane.list", {});
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
        const msg = JSON.parse(line);
        if (msg.error) return void (log(`herdr: subscription ${msg.error.code}`), retry());
        if (msg.result) return void (warned = false);
        if (/^pane[._](created|closed)$/.test(msg.event)) {
          sock = undefined;
          s.destroy();
          return void start();
        }
        if (msg.event !== "pane.agent_status_changed") return;
        const d = msg.data as StatusChange;
        const what = NOTIFY[d.agent_status];
        if (!what || !d.agent) return;
        const where = cwds.get(d.pane_id);
        notify(`${d.display_agent ?? d.agent} ${what}`, [d.title, d.pane_id, where].filter(Boolean).join(" · "));
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
