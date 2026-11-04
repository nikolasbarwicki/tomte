import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type { ChatSummary, Notice, ServerEvent } from "./events.ts";

type Item =
  | { kind: "user" | "assistant" | "error" | "info" | "update"; text: string }
  | { kind: "tool"; name: string; input: string }
  | { kind: "ask"; id: string; question: string; answer?: string }
  | { kind: "approve"; id: string; tool: string; reason: string; input: string; answer?: string };

type Info = { sessionId: string; cwd: string; cli: string; auth: string };

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
    case "done":
    case "reset":
    case "notify":
      return items;
  }
}

function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [info, setInfo] = useState<Info>();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [toasts, setToasts] = useState<Notice[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshChats = () => fetch("/api/chats").then(async (r) => setChats(await r.json()));

  useEffect(() => {
    post("/api/info", {}).then(async (r) => {
      const i: Info = await r.json();
      setInfo(i);
      setSessionId(i.sessionId);
    });
    refreshChats();
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as ServerEvent;
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
        setSessionId(e.sessionId);
        return;
      }
      if (e.type === "user" || e.type === "update") setBusy(true);
      if (e.type === "done" || e.type === "error") {
        setBusy(false);
        refreshChats();
      }
      setItems((prev) => reduce(prev, e));
    };
    return () => es.close();
  }, []);

  const switchChat = async (path: "/api/new" | "/api/open", id?: string) => {
    const r = await post(path, { sessionId: id });
    if (!r.ok) alert((await r.json()).error);
    refreshChats();
  };

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    post("/api/send", { text });
  };

  return (
    <div className="shell">
    <aside>
      <button className="new" onClick={() => switchChat("/api/new")} disabled={busy}>
        + New chat
      </button>
      {chats.map((c) => (
        <button
          key={c.sessionId}
          className={`chat ${c.sessionId === sessionId ? "active" : ""}`}
          disabled={busy}
          onClick={() => switchChat("/api/open", c.sessionId)}
          title={c.sessionId}
        >
          <span>{c.title}</span>
          <small>{new Date(c.lastModified).toLocaleString()}</small>
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
        <strong>claudebot</strong>
        {info && (
          <span className="meta" title={info.cli}>
            {info.cwd} · {info.auth} · session {sessionId?.slice(0, 8)}
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
      </header>
      <main>
        {items.map((it, i) => (
          <Row key={i} item={it} />
        ))}
        {busy && <div className="typing">Claude is working…</div>}
        <div ref={bottom} />
      </main>
      <footer>
        <textarea
          value={input}
          placeholder="Message Claude Code (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={busy || !input.trim()}>
          Send
        </button>
      </footer>
    </div>
    <div className="toasts">
      {toasts.map((n) => (
        <NoticeView key={`${n.at}-${n.title}`} n={n} />
      ))}
    </div>
    </div>
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
