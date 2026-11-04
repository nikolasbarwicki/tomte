import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type { Bot, BotFile, ContextEvent, FilesEvent, MemoryEvent, MemoryScope, Notice, ServerEvent } from "./events.ts";

type Item =
  | { kind: "user" | "assistant" | "error" | "info" | "update"; text: string }
  | { kind: "tool"; name: string; input: string }
  | { kind: "ask"; id: string; question: string; answer?: string }
  | { kind: "approve"; id: string; tool: string; reason: string; input: string; answer?: string }
  | { kind: "session" };

const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

type Info = { cwd: string; cli: string; auth: string };

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function reduce(items: Item[], e: ServerEvent): Item[] {
  const last = items[items.length - 1];
  switch (e.type) {
    case "user":
      return [...items, { kind: "user", text: e.text }];
    case "text_start":
      return [...items, { kind: "assistant", text: "" }];
    case "delta":
      return last?.kind === "assistant"
        ? [...items.slice(0, -1), { ...last, text: last.text + e.text }]
        : [...items, { kind: "assistant", text: e.text }];
    case "tool":
      return [...items, { kind: "tool", name: e.name, input: e.input }];
    case "ask":
      return [...items, { kind: "ask", id: e.id, question: e.question }];
    case "approve":
      return [...items, { kind: "approve", id: e.id, tool: e.tool, reason: e.reason, input: e.input }];
    case "answered":
      return items.map((i) => ((i.kind === "ask" || i.kind === "approve") && i.id === e.id ? { ...i, answer: e.value } : i));
    case "error":
      return [...items, { kind: "error", text: e.message }];
    case "info":
      return [...items, { kind: "info", text: e.text }];
    case "update":
      return [...items, { kind: "update", text: `📣 ${e.text}` }];
    case "session":
      return [...items, { kind: "session" }];
    case "compacted":
      return [...items, { kind: "info", text: `context compacted (${e.trigger}) · ${kTokens(e.preTokens)} tokens summarized` }];
    case "done":
    case "reset":
    case "notify":
    case "context":
      return items;
  }
}

function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [info, setInfo] = useState<Info>();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [toasts, setToasts] = useState<Notice[]>([]);
  const [memory, setMemory] = useState<Record<MemoryScope, string>>({ user: "", bot: "" });
  const [context, setContext] = useState<ContextEvent>();
  const [files, setFiles] = useState<FilesEvent>({ type: "files", dir: "", files: [] });
  const bottom = useRef<HTMLDivElement>(null);
  const bot = bots.find((b) => b.id === botId);

  const refreshBots = () =>
    fetch("/api/bots").then(async (r) => {
      const list: Bot[] = await r.json();
      setBots(list);
      if (!list.length) setCreating(true);
    });

  useEffect(() => {
    post("/api/info", {}).then(async (r) => setInfo(await r.json()));
    refreshBots();
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as ServerEvent | MemoryEvent | FilesEvent;
      if (e.type === "memory") return setMemory((prev) => ({ ...prev, [e.scope]: e.text }));
      if (e.type === "files") return setFiles(e);
      if (e.type === "notify") {
        setNotices((prev) => [e, ...prev].slice(0, 50));
        if (Date.now() - e.at < 5_000) {
          setToasts((prev) => [...prev, e]);
          setTimeout(() => setToasts((prev) => prev.filter((t) => t !== e)), 6_000);
        }
        return;
      }
      if (e.type === "reset") {
        setItems([]);
        setBusy(false);
        setContext(undefined);
        setBotId(e.botId);
        refreshBots();
        return;
      }
      if (e.type === "context") return setContext(e);
      if (e.type === "session") setContext(undefined);
      if (e.type === "user" || e.type === "update") setBusy(true);
      if (e.type === "done" || e.type === "error") {
        setBusy(false);
        refreshBots();
      }
      setItems((prev) => reduce(prev, e));
    };
    return () => es.close();
  }, []);

  const openBot = async (id: string) => {
    const r = await post("/api/open", { botId: id });
    if (!r.ok) alert((await r.json()).error);
  };

  const startSession = async () => {
    if (!confirm(`Start a new session for ${bot?.name}? Claude will forget this conversation; memory is kept.`)) return;
    const r = await post("/api/session/new", {});
    if (!r.ok) alert(`New session failed (${r.status}): ${await r.text()}`);
  };

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  const send = () => {
    const text = input.trim();
    if (!text || busy || !botId) return;
    setInput("");
    post("/api/send", { text });
  };

  return (
    <div className="shell">
    <aside>
      <button className="new" onClick={() => setCreating(true)} disabled={busy}>
        + New bot
      </button>
      {creating && <NewBot onDone={() => setCreating(false)} canCancel={bots.length > 0} />}
      {bots.map((b) => (
        <button key={b.id} className={`chat ${b.id === botId ? "active" : ""}`} disabled={busy} onClick={() => openBot(b.id)} title={b.purpose || b.id}>
          <span>{b.name}</span>
          {b.purpose && <small className="purpose">{b.purpose}</small>}
          <small>{new Date(b.lastActive).toLocaleString()}</small>
        </button>
      ))}
      {notices.length > 0 && (
        <section className="notices">
          <h4>Updates</h4>
          {notices.map((n) => (
            <NoticeView key={`${n.at}-${n.title}`} n={n} />
          ))}
        </section>
      )}
    </aside>
    <div className="app">
      <header>
        <strong>{bot?.name ?? "claudebot"}</strong>
        {info && (
          <span className="meta" title={info.cli}>
            {bot?.purpose ? `${bot.purpose} · ` : ""}
            {info.cwd} · {info.auth}
          </span>
        )}
        <select defaultValue="" onChange={(e) => e.target.value && post("/api/model", { model: e.target.value })}>
          <option value="">model…</option>
          <option value="opus">opus</option>
          <option value="sonnet">sonnet</option>
          <option value="haiku">haiku</option>
        </select>
        <select defaultValue="" onChange={(e) => e.target.value && post("/api/effort", { effort: e.target.value })}>
          <option value="">effort…</option>
          {["low", "medium", "high", "max"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <span
          className={`context ${(context?.percentage ?? 0) >= 80 ? "high" : ""}`}
          title={context ? `${context.tokens.toLocaleString()} / ${context.max.toLocaleString()} tokens` : "Context usage appears after the next reply"}
        >
          <meter min={0} max={100} value={context?.percentage ?? 0} />
          {context ? `${context.percentage}% · ${kTokens(context.tokens)}/${kTokens(context.max)}` : "context –"}
        </span>
        <button onClick={startSession} disabled={busy || !botId} title="Start a fresh Claude Code session in this bot">
          New session
        </button>
      </header>
      <main>
        {!botId && <p className="meta">Create a bot to start. Each bot is one long-running conversation dedicated to one job.</p>}
        {items.map((it, i) => (
          <Row key={i} item={it} />
        ))}
        {busy && <div className="typing">Claude is working…</div>}
        <div ref={bottom} />
      </main>
      <footer>
        <textarea
          value={input}
          placeholder={bot ? `Message ${bot.name} (Enter to send, Shift+Enter for newline)` : "Create a bot first"}
          disabled={!botId}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={busy || !botId || !input.trim()}>
          Send
        </button>
      </footer>
    </div>
    <aside className="memory">
      <h3>About you</h3>
      <p className="meta">Shared by all bots</p>
      {memory.user ? <pre>{memory.user}</pre> : <p className="meta">Nothing remembered yet.</p>}
      <h3>{bot ? `How ${bot.name} works` : "Bot memory"}</h3>
      <p className="meta">Only this bot</p>
      {memory.bot ? <pre>{memory.bot}</pre> : <p className="meta">No directions yet.</p>}
      {botId && <Files dir={files.dir} files={files.files} />}
    </aside>
    <div className="toasts">
      {toasts.map((n) => (
        <NoticeView key={`${n.at}-${n.title}`} n={n} />
      ))}
    </div>
    </div>
  );
}

function NewBot({ onDone, canCancel }: { onDone: () => void; canCancel: boolean }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  return (
    <form
      className="newbot"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await post("/api/bots/new", { name, purpose });
        if (!r.ok) return alert((await r.json()).error);
        onDone();
      }}
    >
      <input autoFocus placeholder="Name, e.g. PR reviewer" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea placeholder="What is this bot for? (optional)" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      <div className="actions">
        <button disabled={!name.trim()}>Create</button>
        {canCancel && (
          <button type="button" className="deny" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

const fileSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

function Files({ dir, files }: { dir: string; files: BotFile[] }) {
  const reveal = async (path?: string) => {
    const r = await post("/api/files/reveal", { path });
    if (!r.ok) alert((await r.json()).error);
  };
  const remove = async (path: string) => {
    if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
    const r = await post("/api/files/delete", { path });
    if (!r.ok) alert((await r.json()).error);
  };
  return (
    <section className="files">
      <div className="files-head">
        <h3>Files</h3>
        <button className="link" onClick={() => reveal()} title={dir}>
          Open folder
        </button>
      </div>
      <p className="meta">Everything this bot produced</p>
      {files.length === 0 && <p className="meta">No files yet.</p>}
      {files.map((f) => (
        <div key={f.path} className="file" title={f.path}>
          <span className="name">{f.path}</span>
          <small>
            {fileSize(f.size)} · {new Date(f.mtime).toLocaleString()}
          </small>
          <div className="file-actions">
            <button className="link" onClick={() => reveal(f.path)}>
              Show in Finder
            </button>
            <button className="link danger" onClick={() => remove(f.path)}>
              Delete
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function NoticeView({ n }: { n: Notice }) {
  return (
    <div className="notice" title={n.body}>
      <strong>{n.title}</strong>
      {n.body && <span>{n.body}</span>}
      <small>
        {n.source} · {new Date(n.at).toLocaleTimeString()}
      </small>
    </div>
  );
}

function Row({ item }: { item: Item }) {
  const [reply, setReply] = useState("");
  switch (item.kind) {
    case "user":
      return <div className="msg user">{item.text}</div>;
    case "assistant":
      return (
        <div className="msg assistant md">
          <Streamdown linkSafety={{ enabled: false }}>{item.text}</Streamdown>
        </div>
      );
    case "error":
    case "info":
    case "update":
      return <div className={`note ${item.kind}`}>{item.text}</div>;
    case "session":
      return <div className="session">New session started · earlier messages are no longer in Claude's context</div>;
    case "tool":
      return (
        <details className="tool">
          <summary>🔧 {item.name}</summary>
          <pre>{item.input}</pre>
        </details>
      );
    case "ask":
      return (
        <div className="card">
          <div>
            <b>Claude asks:</b> {item.question}
          </div>
          {item.answer !== undefined ? (
            <div className="answered">→ {item.answer}</div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                post("/api/answer", { id: item.id, value: reply });
              }}
            >
              <input autoFocus value={reply} onChange={(e) => setReply(e.target.value)} />
              <button>Answer</button>
            </form>
          )}
        </div>
      );
    case "approve":
      return (
        <div className="card">
          <div>
            <b>Allow {item.tool}?</b> <span className="meta">{item.reason}</span>
          </div>
          <pre>{item.input}</pre>
          {item.answer !== undefined ? (
            <div className="answered">→ {item.answer}</div>
          ) : (
            <div className="actions">
              <button onClick={() => post("/api/answer", { id: item.id, value: "allow" })}>Allow</button>
              <button className="deny" onClick={() => post("/api/answer", { id: item.id, value: "deny" })}>
                Deny
              </button>
            </div>
          )}
        </div>
      );
  }
}

createRoot(document.getElementById("root")!).render(<App />);
