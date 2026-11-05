import { useState } from "react";
import type { BotSummary, CredentialEntry } from "./events.ts";
import { post } from "./api.ts";

/** The global Credentials screen; passwords are write-only and never shown or pre-filled. */
export function Credentials({ credentials, bots }: { credentials: CredentialEntry[]; bots: BotSummary[] }) {
  const [adding, setAdding] = useState(false);
  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? `deleted bot (${id.slice(0, 8)})`;
  const byBot = new Map<string, CredentialEntry[]>();
  for (const c of credentials) for (const g of c.grants) byBot.set(g.botId, [...(byBot.get(g.botId) ?? []), c]);
  const revoke = async (botId: string, id: string) => {
    const r = await post("/api/credentials/revoke", { botId, id });
    if (!r.ok) alert((await r.json()).error);
  };
  return (
    <div className="integrations">
      <header>
        <strong>Credentials</strong>
        <span className="meta">Website logins for bots. Passwords are kept in the OS keychain and are never shown again.</span>
      </header>
      <div className="integration-grid">
        {credentials.map((c) => (
          <CredentialCard key={c.id} entry={c} botName={botName} revoke={revoke} />
        ))}
        <section className="integration-card">
          <h3>New credential</h3>
          {adding ? <CredentialForm onDone={() => setAdding(false)} /> : <button onClick={() => setAdding(true)}>Add</button>}
        </section>
        {byBot.size > 0 && (
          <section className="integration-card">
            <h3>Access by bot</h3>
            {[...byBot].map(([botId, entries]) => (
              <div key={botId}>
                <h4>{botName(botId)}</h4>
                <ul className="integration-skills">
                  {entries.map((e) => (
                    <li key={e.id}>
                      {e.label}{" "}
                      <button onClick={() => revoke(botId, e.id)}>Revoke</button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function CredentialCard({ entry: c, botName, revoke }: { entry: CredentialEntry; botName: (id: string) => string; revoke: (botId: string, id: string) => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <section className="integration-card">
      <div className="integration-head">
        <h3>{c.label}</h3>
        <span className="meta">{c.username}</span>
      </div>
      <p className="meta" title={c.signInUrl}>{c.origin}</p>
      {editing ? (
        <CredentialForm entry={c} onDone={() => setEditing(false)} />
      ) : (
        <div className="actions">
          <button onClick={() => setEditing(true)}>Edit</button>
          <button
            onClick={async () => {
              if (!confirm(`Delete "${c.label}"? Its password and every bot's access are removed.`)) return;
              const r = await post("/api/credentials/remove", { id: c.id });
              if (!r.ok) alert((await r.json()).error);
            }}
          >
            Delete
          </button>
        </div>
      )}
      <h4>Bots with access</h4>
      {c.grants.length === 0 ? (
        <p className="meta">None yet. A bot asks the first time it wants to sign in.</p>
      ) : (
        <ul className="integration-skills">
          {c.grants.map((g) => (
            <li key={g.botId}>
              {botName(g.botId)} <button onClick={() => revoke(g.botId, c.id)}>Revoke</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CredentialForm({ entry, onDone }: { entry?: CredentialEntry; onDone: () => void }) {
  const [label, setLabel] = useState(entry?.label ?? "");
  const [signInUrl, setSignInUrl] = useState(entry?.signInUrl ?? "");
  const [username, setUsername] = useState(entry?.username ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await post(entry ? "/api/credentials/update" : "/api/credentials/add", { id: entry?.id, label, signInUrl, username, password });
    setBusy(false);
    if (!r.ok) return setError((await r.json()).error);
    setPassword("");
    onDone();
  };
  return (
    <form className="custom-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input placeholder="Label, e.g. GitHub" value={label} onChange={(e) => setLabel(e.target.value)} />
      <input placeholder="Sign-in URL (https)" value={signInUrl} onChange={(e) => setSignInUrl(e.target.value)} />
      <input placeholder="Username" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
      <input type="password" autoComplete="new-password" placeholder={entry ? "New password (leave empty to keep)" : "Password"} value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="form-error">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={busy}>{entry ? "Save" : "Add"}</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
