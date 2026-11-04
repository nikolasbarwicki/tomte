// omp hook: forwards session updates to claudebot's POST /api/notify.
// Install: ln -s "$PWD/integrations/omp/claudebot-notify.ts" ~/.omp/agent/hooks/post/
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const URL = `${process.env.CLAUDEBOT_URL ?? "http://127.0.0.1:5173"}/api/notify`;

export default function claudebotNotify(pi: ExtensionAPI) {
  const post = (title: string, body: string) =>
    fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "omp", title, body }),
      signal: AbortSignal.timeout(2_000),
    }).catch(() => {});

  const project = (cwd: string) => cwd.split("/").pop() ?? cwd;

  pi.on("agent_end", (event, ctx) => {
    if (event.willContinue) return;
    const last = event.messages.findLast((m) => m.role === "assistant");
    const text = Array.isArray(last?.content)
      ? last.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(" ")
      : "";
    return post(`omp finished · ${project(ctx.cwd)}`, text.slice(0, 240));
  });

  pi.on("tool_approval_requested", (event, ctx) =>
    post(`omp needs approval · ${project(ctx.cwd)}`, [event.toolName, event.reason].filter(Boolean).join(": ")),
  );

  pi.on("auto_retry_end", (event, ctx) => {
    if (!event.success) return post(`omp retries failed · ${project(ctx.cwd)}`, event.finalError ?? "");
  });
}
