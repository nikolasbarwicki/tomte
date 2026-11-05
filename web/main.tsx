import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type {
  BotFile,
  BotStatus,
  BotsEvent,
  BotSummary,
  ContextEvent,
  FilesEvent,
  CredentialEntry,
  CredentialsEvent,
  Integration,
  IntegrationsEvent,
  MemoryEvent,
  MemoryScope,
  Notice,
  Routine,
  RoutineRun,
  RoutinesEvent,
  ServerEvent,
} from "./events.ts";
import { post } from "./api.ts";
import { Credentials } from "./credentials.tsx";
import { Integrations } from "./integrations.tsx";
import { DAYS, browserZone, describe, fromSchedule, toSchedule, type Preset } from "./schedule.ts";

type Item =
  | { kind: "user" | "assistant" | "error" | "info" | "update"; text: string }
  | { kind: "tool"; name: string; input: string }
  | { kind: "ask"; id: string; question: string; answer?: string }
  | { kind: "approve"; id: string; tool: string; reason: string; input: string; answer?: string }
  | { kind: "session" }
  | { kind: "routine"; name: string; trigger: string };

const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

/** Clock time for today, weekday within the past week, otherwise the date. */
const lastMessageTime = (t: number) => {
  const d = new Date(t);
  const now = new Date();
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const daysAgo = Math.round((midnight(now) - midnight(d)) / 86_400_000);
  if (daysAgo === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (daysAgo > 0 && daysAgo < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
};

const STATUS_LABEL: Record<BotStatus, string> = { idle: "Idle", working: "Working…", unseen: "Finished, not seen yet" };

type BrowserStatus = { status: "available"; path: string; source: string } | { status: "unavailable"; reason: string };
type Info = { cwd: string; cli: string; auth: string; browser: BrowserStatus };


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
    case "routine":
      return [...items, { kind: "routine", name: e.name, trigger: e.trigger }];
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
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [botId, setBotId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [toasts, setToasts] = useState<Notice[]>([]);
  const [memory, setMemory] = useState<Record<MemoryScope, string>>({ user: "", bot: "" });
  const [context, setContext] = useState<ContextEvent>();
  const [files, setFiles] = useState<FilesEvent>({ type: "files", dir: "", files: [] });
  const [routines, setRoutines] = useState<RoutinesEvent>();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [credentials, setCredentials] = useState<CredentialEntry[]>([]);
  const [view, setView] = useState<"chat" | "integrations" | "credentials">("chat");
  const bottom = useRef<HTMLDivElement>(null);
  const bot = bots.find((b) => b.id === botId);
  const browserUnavailable = info?.browser.status === "unavailable" ? info.browser.reason : undefined;

  useEffect(() => {
    post("/api/info", {}).then(async (r) => setInfo(await r.json()));
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as ServerEvent | MemoryEvent | FilesEvent | RoutinesEvent | BotsEvent | IntegrationsEvent | CredentialsEvent;
      if (e.type === "integrations") return setIntegrations(e.integrations);
      if (e.type === "credentials") return setCredentials(e.credentials);
      if (e.type === "memory") return setMemory((prev) => ({ ...prev, [e.scope]: e.text }));
      if (e.type === "files") return setFiles(e);
      if (e.type === "routines") return setRoutines(e);
      if (e.type === "bots") {
        setBots(e.bots);
        if (!e.bots.length) setCreating(true);
        return;
      }
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
        return;
      }
      if (e.type === "context") return setContext(e);
      if (e.type === "session") setContext(undefined);
      if (e.type === "user" || e.type === "update" || e.type === "routine") setBusy(true);
      if (e.type === "done" || e.type === "error") setBusy(false);
      setItems((prev) => reduce(prev, e));
    };
    return () => es.close();
  }, []);

  // A finished turn counts as seen once the open bot's chat is actually on screen.
  useEffect(() => {
    if (!botId || bot?.status !== "unseen") return;
    const markSeen = () => document.visibilityState === "visible" && post("/api/seen", { botId });
    markSeen();
    document.addEventListener("visibilitychange", markSeen);
    return () => document.removeEventListener("visibilitychange", markSeen);
  }, [botId, bot?.status]);

  const openBot = async (id: string) => {
    setView("chat");
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
      <button className="new" onClick={() => setCreating(true)}>
        + New bot
      </button>
      <button className={`chat ${view === "integrations" ? "active" : ""}`} aria-pressed={view === "integrations"} onClick={() => setView(view === "integrations" ? "chat" : "integrations")}>
        <span className="name">Integrations</span>
      </button>
      <button className={`chat ${view === "credentials" ? "active" : ""}`} aria-pressed={view === "credentials"} onClick={() => setView(view === "credentials" ? "chat" : "credentials")}>
        <span className="name">Credentials</span>
      </button>
      {creating && <NewBot onDone={() => setCreating(false)} canCancel={bots.length > 0} />}
      {bots.map((b) => (
        <button key={b.id} className={`chat ${b.status} ${b.id === botId ? "active" : ""}`} onClick={() => openBot(b.id)} title={b.purpose || b.id}>
          <span className="chat-head">
            <span className={`status ${b.status}`} title={STATUS_LABEL[b.status]} aria-label={STATUS_LABEL[b.status]} />
            <span className="name">{b.name}</span>
            {b.last && (
              <small className="time" title={new Date(b.last.at).toLocaleString()}>
                {lastMessageTime(b.last.at)}
              </small>
            )}
          </span>
          <small className="preview">{b.last ? `${b.last.from === "user" ? "You: " : ""}${b.last.text}` : "No messages yet"}</small>
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
    {view === "integrations" ? (
      <Integrations integrations={integrations} />
    ) : view === "credentials" ? (
      <Credentials credentials={credentials} bots={bots} />
    ) : (
    <>
    <div className="app">
      <header>
        <strong>{bot?.name ?? "claudebot"}</strong>
        {info && (
          <span className="meta" title={info.cli}>
            {bot?.purpose ? `${bot.purpose} · ` : ""}
            {info.cwd} · {info.auth}
          </span>
        )}
        <label className="browser-switch" title={browserUnavailable ?? "Give this bot its own web browser"}>
          <input
            type="checkbox"
            checked={bot?.browser.enabled ?? false}
            disabled={!bot || (!!browserUnavailable && !bot.browser.enabled)}
            onChange={(e) => bot && post("/api/bots/browser", { botId: bot.id, enabled: e.target.checked })}
          />
          Browser
          {browserUnavailable && <small>unavailable: {browserUnavailable}</small>}
        </label>
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
      {botId && routines?.botId === botId && <Routines key={botId} botId={botId} routines={routines.routines} />}
    </aside>
    </>
    )}
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

function Routines({ botId, routines }: { botId: string; routines: Routine[] }) {
  const [editing, setEditing] = useState<Routine | "new">();
  return (
    <section className="routines">
      <div className="files-head">
        <h3>Routines</h3>
        <button className="link" onClick={() => setEditing("new")}>
          + New
        </button>
      </div>
      <p className="meta">Instructions this bot runs on a schedule</p>
      {editing && (
        <RoutineForm botId={botId} routine={editing === "new" ? undefined : editing} onDone={() => setEditing(undefined)} />
      )}
      {routines.length === 0 && !editing && <p className="meta">No routines yet.</p>}
      {routines.map((r) => (
        <RoutineRow key={r.id} r={r} onEdit={() => setEditing(r)} />
      ))}
    </section>
  );
}

function RoutineRow({ r, onEdit }: { r: Routine; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const lastRunId = r.lastRun?.id;
  useEffect(() => {
    if (!open) return;
    post("/api/routines/runs", { id: r.id }).then(async (res) => res.ok && setRuns(await res.json()));
  }, [open, r.id, lastRunId, r.lastRun?.status]);

  const call = async (path: string, body: unknown) => {
    const res = await post(path, body);
    if (!res.ok) alert((await res.json()).error);
  };
  const remove = () => confirm(`Delete routine "${r.name}"?`) && call("/api/routines/delete", { id: r.id });
  const status = r.running ? "running" : r.lastRun?.status;
  const next = !r.active ? "Paused" : r.nextRunAt ? `Next: ${new Date(r.nextRunAt).toLocaleString()}` : "Done";

  return (
    <div className="routine">
      <div className="routine-head">
        <input type="checkbox" checked={r.active} title="Active" onChange={(e) => call("/api/routines/update", { id: r.id, active: e.target.checked })} />
        <button className="link name" onClick={() => setOpen(!open)} title="Show run history">
          {open ? "▾" : "▸"} {r.name}
        </button>
        {status && <span className={`badge ${status}`}>{status}</span>}
      </div>
      <small>{describe(r.schedule)}</small>
      <small>{next}</small>
      <div className="file-actions">
        <button className="link" disabled={r.running} onClick={() => call("/api/routines/run", { id: r.id })}>
          {r.running ? "Running…" : "Test run"}
        </button>
        <button className="link" onClick={onEdit}>
          Edit
        </button>
        <button className="link danger" onClick={remove}>
          Delete
        </button>
      </div>
      {open && (
        <div className="runs">
          {runs.length === 0 && <p className="meta">No runs yet.</p>}
          {runs.map((run) => (
            <details key={run.id} className="run">
              <summary>
                <span className={`badge ${run.status}`}>{run.status}</span> {new Date(run.startedAt).toLocaleString()} · {run.trigger}
              </summary>
              {run.error && <div className="note error">{run.error}</div>}
              {run.output && (
                <div className="md">
                  <Streamdown linkSafety={{ enabled: false }}>{run.output}</Streamdown>
                </div>
              )}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Epoch ms to the local "YYYY-MM-DDTHH:MM" a datetime-local input expects. */
const localInput = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

function RoutineForm({ botId, routine, onDone }: { botId: string; routine?: Routine; onDone: () => void }) {
  const initial: Preset = routine ? fromSchedule(routine.schedule) : { kind: "daily", time: "09:00" };
  const [name, setName] = useState(routine?.name ?? "");
  const [instruction, setInstruction] = useState(routine?.instruction ?? "");
  const [kind, setKind] = useState<Preset["kind"]>(initial.kind);
  const [minute, setMinute] = useState(initial.kind === "hourly" ? initial.minute : 0);
  const [time, setTime] = useState("time" in initial ? initial.time : "09:00");
  const [day, setDay] = useState(initial.kind === "weekly" ? initial.day : 1);
  const [at, setAt] = useState(localInput(initial.kind === "once" ? initial.at : Date.now() + 60 * 60_000));
  const [expr, setExpr] = useState(initial.kind === "custom" ? initial.expr : routine?.schedule.kind === "cron" ? routine.schedule.expr : "0 9 * * *");
  const [tz, setTz] = useState(routine?.schedule.kind === "cron" ? routine.schedule.tz : browserZone());
  const [catchUp, setCatchUp] = useState(routine?.catchUp ?? true);
  const [preview, setPreview] = useState<{ next?: number[]; error?: string }>({});
  const [error, setError] = useState("");

  const preset: Preset =
    kind === "hourly"
      ? { kind, minute }
      : kind === "weekly"
        ? { kind, day, time }
        : kind === "daily" || kind === "weekdays"
          ? { kind, time }
          : kind === "once"
            ? { kind, at: new Date(at).getTime() }
            : { kind, expr };
  const schedule = toSchedule(preset, tz.trim());
  const scheduleKey = JSON.stringify(schedule);

  useEffect(() => {
    const t = setTimeout(async () => {
      const res = await post("/api/routines/preview", { schedule });
      setPreview(await res.json());
    }, 300);
    return () => clearTimeout(t);
  }, [scheduleKey]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = { name, instruction, schedule, catchUp };
    const res = routine
      ? await post("/api/routines/update", { id: routine.id, ...payload })
      : await post("/api/routines/create", { botId, ...payload });
    if (!res.ok) return setError((await res.json()).error ?? `failed (${res.status})`);
    onDone();
  };

  return (
    <form className="newbot routine-form" onSubmit={submit}>
      <input autoFocus placeholder="Name, e.g. Morning digest" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea placeholder="Instruction: what should the bot do each time?" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      <select value={kind} onChange={(e) => setKind(e.target.value as Preset["kind"])}>
        <option value="hourly">Every hour</option>
        <option value="daily">Every day</option>
        <option value="weekdays">Weekdays</option>
        <option value="weekly">Every week</option>
        <option value="once">Once</option>
        <option value="custom">Custom cron</option>
      </select>
      {kind === "hourly" && (
        <label>
          at minute <input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(Number(e.target.value))} />
        </label>
      )}
      {kind === "weekly" && (
        <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
          {DAYS.map((d, i) => (
            <option key={d} value={i}>
              {d}
            </option>
          ))}
        </select>
      )}
      {(kind === "daily" || kind === "weekdays" || kind === "weekly") && <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />}
      {kind === "once" && <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
      {kind === "custom" && <input placeholder="Custom cron, e.g. 30 8 * * 1" value={expr} onChange={(e) => setExpr(e.target.value)} />}
      {kind !== "once" && <input placeholder="Time zone" title="IANA time zone" value={tz} onChange={(e) => setTz(e.target.value)} />}
      <label>
        <input type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} /> Catch up after downtime (up to 12 h)
      </label>
      <div className="meta preview">
        {preview.error
          ? <span className="error">{preview.error}</span>
          : preview.next?.length
            ? <>Next: {preview.next.map((t) => new Date(t).toLocaleString()).join(" · ")}</>
            : "…"}
      </div>
      {error && <div className="note error">{error}</div>}
      <div className="actions">
        <button disabled={!name.trim() || !instruction.trim()}>{routine ? "Save" : "Create"}</button>
        <button type="button" className="deny" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
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
    case "routine":
      return (
        <div className="routine-start">
          ⏰ Routine <b>{item.name}</b> · {item.trigger === "manual" ? "test run" : "scheduled"}
        </div>
      );
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
