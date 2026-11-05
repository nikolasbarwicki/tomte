import { useState } from "react";
import type { Integration, OwnClient, ToolPolicy } from "./events.ts";
import { post } from "./api.ts";

const STATE_LABEL: Record<Integration["state"], string> = {
  disconnected: "Disconnected",
  connected: "Connected",
  "needs-auth": "Needs sign-in",
  failed: "Failed",
};

/** Opens the provider's sign-in page in `tab`, which the caller opened inside the click so the browser allows it. */
async function signIn(id: string, tab: Window | null, client?: { clientId: string; clientSecret: string }): Promise<string | undefined> {
  const r = await post("/api/integrations/connect-oauth", { id, ...client });
  const body = await r.json();
  if (!r.ok) {
    tab?.close();
    return body.error;
  }
  if (tab) tab.location.href = body.authorizeUrl;
  else window.open(body.authorizeUrl, "_blank");
}

/** The global Integrations screen; it replaces the chat and memory columns. */
export function Integrations({ integrations }: { integrations: Integration[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="integrations">
      <header>
        <strong>Integrations</strong>
        <span className="meta">Shared by every bot. Changes apply on each bot's next turn.</span>
      </header>
      <div className="integration-grid">
        {integrations.map((i) => (
          <IntegrationCard key={i.id} integration={i} />
        ))}
        <section className="integration-card">
          <h3>Custom MCP server</h3>
          <p className="meta">Connect a remote server by name and URL.</p>
          {adding ? <CustomForm onDone={() => setAdding(false)} /> : <button onClick={() => setAdding(true)}>Add</button>}
        </section>
      </div>
    </div>
  );
}

function IntegrationCard({ integration: i }: { integration: Integration }) {
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const shown = i.tools.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const act = async (path: string, confirmText?: string, extra: Record<string, unknown> = {}) => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    const r = await post(path, { id: i.id, ...extra });
    setBusy(false);
    if (!r.ok) alert((await r.json()).error);
  };
  const endpoint = i.transport.type === "stdio" ? [i.transport.command, ...i.transport.args, ...i.transport.envKeys.map((k) => `${k}=•••`)].join(" ") : i.transport.url;
  return (
    <section className={`integration-card ${i.state}`}>
      <div className="integration-head">
        <h3>{i.label}</h3>
        <span className={`badge state-${i.state}`}>{STATE_LABEL[i.state]}</span>
      </div>
      <p className="meta" title={endpoint}>
        {i.transport.type.toUpperCase()} · {endpoint}
      </p>
      {i.note && <p className="meta">{i.note}</p>}
      {i.error && <p className="form-error">{i.error}</p>}
      {i.auth.kind === "oauth" && i.auth.client === "own" && i.state !== "connected" && <OwnClientForm integration={i} ownClient={i.auth.ownClient} />}
      {i.auth.kind === "oauth" && i.auth.client === "dcr" && i.state !== "connected" && (
        <div className="actions">
          <button
            disabled={busy}
            onClick={async () => {
              const tab = window.open("", "_blank");
              setBusy(true);
              const error = await signIn(i.id, tab);
              setBusy(false);
              if (error) alert(error);
            }}
          >
            Connect
          </button>
        </div>
      )}
      {i.auth.kind === "bearer" && i.state !== "connected" && <TokenForm integration={i} />}
      {i.auth.kind === "bearer" && i.auth.ownClient && i.state !== "connected" && (
        <details>
          <summary className="meta">Use OAuth with your own app instead</summary>
          <OwnClientForm integration={i} ownClient={i.auth.ownClient} />
        </details>
      )}
      {i.auth.kind === "oauth" && i.auth.alternative && i.state !== "connected" && (
        <details>
          <summary className="meta">Use an {i.auth.alternative.tokenLabel} instead</summary>
          <TokenForm integration={i} />
        </details>
      )}
      <label className="switch">
        <input type="checkbox" checked={i.enabled} onChange={(e) => act("/api/integrations/set-enabled", undefined, { enabled: e.target.checked })} />
        Enabled
      </label>
      {i.tools.length > 0 && (
        <>
          <div className="tool-bar">
            <input type="search" placeholder="Filter tools" aria-label={`Filter ${i.name} tools`} value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button disabled={busy} onClick={() => act("/api/integrations/reset-policies")} title="Read-only tools Auto, the rest Ask">
              Reset to defaults
            </button>
          </div>
          <ul className="integration-tools">
            {shown.map((t) => (
              <li key={t.name} title={t.description}>
                <code>{t.name}</code>
                {t.readOnly && <span className="badge readonly">read-only</span>}
                {t.destructive && <span className="badge destructive">destructive</span>}
                <fieldset className="seg">
                  <legend className="sr">{t.name} policy</legend>
                  {(["off", "ask", "auto"] as ToolPolicy[]).map((p) => (
                    <label key={p} className={t.policy === p ? `on ${p}` : ""}>
                      <input type="radio" name={`${i.id}:${t.name}`} checked={t.policy === p} onChange={() => act("/api/integrations/set-policy", undefined, { tool: t.name, policy: p })} />
                      {p[0]!.toUpperCase() + p.slice(1)}
                    </label>
                  ))}
                </fieldset>
              </li>
            ))}
          </ul>
          <p className="meta wrap">Ask tools are denied in scheduled routines; set Auto on tools a routine needs.</p>
        </>
      )}
      {(i.skills.length > 0 || i.skillsError) && (
        <>
          <h4>Skills</h4>
          {i.skillsError && <p className="form-error">{i.skillsError}</p>}
          <ul className="integration-skills">
            {i.skills.map((k) => (
              <li key={k.name}>
                <label className="switch">
                  <input type="checkbox" checked={k.enabled} onChange={(e) => act("/api/integrations/set-skill-enabled", undefined, { skill: k.name, enabled: e.target.checked })} />
                  <code>{k.name}</code>
                </label>
                {k.description && <p className="meta wrap">{k.description}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="actions">
        {(i.state === "connected" || (i.auth.kind === "none" && i.catalogId === null)) && (
          <button disabled={busy} onClick={() => act("/api/integrations/probe")}>
            {i.state === "connected" ? "Refresh tools" : i.state === "failed" ? "Retry" : "Reconnect"}
          </button>
        )}
        {i.state === "connected" && (
          <button className="deny" disabled={busy} onClick={() => act("/api/integrations/disconnect", `Disconnect ${i.label}? Its stored secret is deleted; tool settings are kept.`)}>
            Disconnect
          </button>
        )}
        {i.catalogId === null && (
          <button className="deny" disabled={busy} onClick={() => act("/api/integrations/remove", `Remove ${i.name}? Its tool settings are deleted.`)}>
            Remove
          </button>
        )}
      </div>
    </section>
  );
}

function OwnClientForm({ integration: i, ownClient }: { integration: Integration; ownClient: OwnClient }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const tab = window.open("", "_blank");
    setBusy(true);
    const error = await signIn(i.id, tab, { clientId, clientSecret });
    setBusy(false);
    if (error) alert(error);
    else setClientSecret("");
  };
  return (
    <form className="custom-form" onSubmit={submit}>
      <ol className="meta wrap">
        {ownClient.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="meta wrap">
        Redirect address to register: <code>{i.redirectUrl}</code>
      </p>
      <input type="text" autoComplete="off" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label={`${i.label} client ID`} />
      <input type="password" autoComplete="off" placeholder="Client secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} aria-label={`${i.label} client secret`} />
      <div className="actions">
        <button type="submit" disabled={busy || !clientId.trim() || !clientSecret.trim()}>
          Connect
        </button>
      </div>
    </form>
  );
}

function TokenForm({ integration: i }: { integration: Integration }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const label = i.auth.kind === "bearer" ? i.auth : i.auth.kind === "oauth" ? i.auth.alternative : undefined;
  if (!label) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const r = await post("/api/integrations/set-bearer", { id: i.id, token });
    setBusy(false);
    if (r.ok) return setToken("");
    setError((await r.json()).error);
  };
  return (
    <form className="custom-form" onSubmit={submit}>
      <input type="password" autoComplete="off" placeholder={label.tokenLabel ?? "Bearer token"} value={token} onChange={(e) => setToken(e.target.value)} aria-label="Token" />
      {label.tokenUrl && (
        <a href={label.tokenUrl} target="_blank" rel="noreferrer">
          Get a {label.tokenLabel ?? "token"}
        </a>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={busy || !token.trim()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </form>
  );
}

function CustomForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<"http" | "sse" | "stdio">("http");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [token, setToken] = useState("");
  const [oauth, setOauth] = useState(false);
  const [skillsDir, setSkillsDir] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const wantsSignIn = oauth && transport !== "stdio";
    const tab = wantsSignIn ? window.open("", "_blank") : null;
    setBusy(true);
    setError("");
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const at = line.indexOf("=");
      if (line.trim() && at > 0) env[line.slice(0, at).trim()] = line.slice(at + 1);
    }
    const r = await post(
      "/api/integrations/add-custom",
      transport === "stdio" ? { name, transport, command: url, args: args.split(/\s+/).filter(Boolean), env, skillsDir } : { name, url, transport, token: oauth ? undefined : token, oauth, skillsDir },
    );
    const body = await r.json();
    if (!r.ok) {
      tab?.close();
      setBusy(false);
      return setError(body.error);
    }
    const signInError = wantsSignIn ? await signIn(body.id, tab) : undefined;
    setBusy(false);
    if (signInError) return setError(signInError);
    onDone();
  };
  return (
    <form className="custom-form" onSubmit={submit}>
      <input placeholder="Name (e.g. cfdocs)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
      <select value={transport} onChange={(e) => setTransport(e.target.value as "http" | "sse" | "stdio")} aria-label="Transport">
        <option value="http">HTTP</option>
        <option value="sse">SSE</option>
        <option value="stdio">Local command</option>
      </select>
      {transport === "stdio" ? (
        <>
          <input placeholder="Command (e.g. npx)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Command" />
          <input placeholder="Arguments (e.g. -y some-mcp-server)" value={args} onChange={(e) => setArgs(e.target.value)} aria-label="Arguments" />
          <textarea placeholder={"Environment, one KEY=value per line.\nValues are stored in the keychain."} value={envText} onChange={(e) => setEnvText(e.target.value)} aria-label="Environment" autoComplete="off" />
        </>
      ) : (
        <>
          <input placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL" />
          <label className="switch">
            <input type="checkbox" checked={oauth} onChange={(e) => setOauth(e.target.checked)} />
            Sign in with OAuth
          </label>
          {!oauth && <input type="password" autoComplete="off" placeholder="Bearer token (optional)" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Bearer token" />}
        </>
      )}
      <input placeholder="Local skills folder, absolute path (optional)" value={skillsDir} onChange={(e) => setSkillsDir(e.target.value)} aria-label="Skills folder" />
      {error && <p className="form-error">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Add"}
        </button>
        <button type="button" className="deny" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
