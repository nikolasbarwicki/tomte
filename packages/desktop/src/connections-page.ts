import { createHash, randomUUID } from "node:crypto";

import { ConnectionError } from "./connection-error.ts";
import { UPDATE_LABEL } from "./connection-items.ts";
import type { Connections, ProfileView } from "./connections.ts";
import { LOCAL_ID } from "./profile-store.ts";

/** The privileged scheme the Connections window loads from, and the one origin it may navigate to. */
export const CONNECTIONS_SCHEME = "tomte-desktop";
export const CONNECTIONS_ORIGIN = `${CONNECTIONS_SCHEME}://connections`;

const MAX_NOTICES = 20;

/** What the page tells the user after an action. Kept in memory under a random id, so a redirect URL never carries text or secrets. */
interface Notice {
  kind: "ok" | "error";
  text: string;
  /** Refill the Add form after a failed add; the pairing code is never refilled. */
  form?: { name: string; url: string };
  /** Offer to forget this profile without asking the host to revoke it. */
  forgetWithoutRevoking?: string;
}

const STYLE = `
:root{color-scheme:dark}
body{margin:0;padding:24px;background:#111;color:#ddd;font:14px/1.5 system-ui,sans-serif}
h1{font-size:18px;margin:0 0 16px}h2{font-size:15px;margin:28px 0 8px}
ul{list-style:none;margin:0;padding:0}
li{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #333;border-radius:6px;margin-bottom:8px}
li .who{flex:1;min-width:0}li .origin{color:#888;font-size:12px;overflow-wrap:anywhere}
.badge{font-size:11px;color:#8c8;border:1px solid #484;border-radius:10px;padding:0 8px}
form{margin:0}
label{display:block;margin:10px 0 4px;color:#aaa}
input[type=text]{width:100%;box-sizing:border-box;padding:6px 8px;background:#1b1b1b;color:#eee;border:1px solid #444;border-radius:4px;font:inherit}
button{padding:5px 12px;background:#2a2a2a;color:#eee;border:1px solid #555;border-radius:4px;font:inherit;cursor:pointer}
button:hover{background:#353535}
.add button{margin-top:14px}
.notice{padding:10px 12px;border-radius:6px;margin-bottom:16px;border:1px solid}
.notice.ok{border-color:#484;background:#1a2a1a}.notice.error{border-color:#844;background:#2a1a1a}
.hint{color:#888;font-size:12px}
`;
const STYLE_HASH = `sha256-${createHash("sha256").update(STYLE).digest("base64")}`;

const CSP = [
  "default-src 'none'",
  `style-src '${STYLE_HASH}'`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
/** Every interpolated string goes through this: names and errors can come from a remote host. */
const esc = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

function profileRow(profile: ProfileView): string {
  const id = `<input type="hidden" name="id" value="${esc(profile.id)}">`;
  const connect = profile.active
    ? `<span class="badge">connected</span>`
    : `<form method="post" action="/connect">${id}<button>Connect</button></form>`;
  const forget =
    profile.id === LOCAL_ID
      ? ""
      : `<form method="post" action="/forget">${id}<button>Forget</button></form>`;
  const update = profile.update
    ? `<div class="origin">${UPDATE_LABEL[profile.update]}: the tray and notifications cannot follow this host</div>`
    : "";
  return `<li><div class="who"><div>${esc(profile.name)}</div><div class="origin">${esc(profile.origin)}</div>${update}</div>${connect}${forget}</li>`;
}

function noticeHtml(notice: Notice): string {
  const without = notice.forgetWithoutRevoking;
  const extra =
    without === undefined
      ? ""
      : `<form method="post" action="/forget"><input type="hidden" name="id" value="${esc(without)}"><input type="hidden" name="withoutRevoking" value="1"><p>Forgetting it without revoking leaves this app's device valid on the host until you revoke it there (Devices page).</p><button>Forget without revoking</button></form>`;
  return `<div class="notice ${notice.kind}" role="${notice.kind === "error" ? "alert" : "status"}"><div>${esc(notice.text)}</div>${extra}</div>`;
}

function pageHtml(profiles: ProfileView[], notice: Notice | undefined): string {
  const form = notice?.form;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connections</title><style>${STYLE}</style></head><body>
<h1>Connections</h1>
${notice ? noticeHtml(notice) : ""}
<ul>${profiles.map(profileRow).join("")}</ul>
<h2>Add a connection</h2>
<form class="add" method="post" action="/add" autocomplete="off">
<label for="name">Name</label><input type="text" id="name" name="name" value="${esc(form?.name ?? "")}">
<label for="url">Address</label><input type="text" id="url" name="url" placeholder="https://tomte.example.com" value="${esc(form?.url ?? "")}">
<label for="code">Pairing code</label><input type="text" id="code" name="code" placeholder="ABCD-EFGH-IJKL">
<p class="hint">Create the code on the host with <code>host pair</code>, or on its Devices page.</p>
<button>Add</button>
</form></body></html>`;
}

function respond(status: number, headers: Record<string, string>, body: string | null): Response {
  return new Response(body, {
    status,
    headers: { "content-security-policy": CSP, "cache-control": "no-store", ...headers },
  });
}

export interface ConnectionsPages {
  /** Answers a request to the `tomte-desktop:` scheme: the list page, and the form posts that act and redirect back to it. */
  handle(request: Request): Promise<Response>;
  /** Stores a message and returns the id the list page takes as `?m=`. */
  notice(kind: Notice["kind"], text: string): string;
}

/** What the page needs of the connections. */
export type PageConnections = Pick<Connections, "list" | "add" | "connect" | "forget">;

/** The Connections window's server side. Forms post `application/x-www-form-urlencoded` to this scheme and get a 303 back to the list, so no secret ever sits in a URL. */
export function createConnectionsPages(connections: PageConnections): ConnectionsPages {
  const notices = new Map<string, Notice>();

  function remember(notice: Notice): string {
    const id = randomUUID();
    notices.set(id, notice);
    if (notices.size > MAX_NOTICES) notices.delete(notices.keys().next().value!);
    return id;
  }

  const back = (id: string) =>
    respond(303, { location: `${CONNECTIONS_ORIGIN}/?m=${encodeURIComponent(id)}` }, null);

  /** Runs the action a form post names and returns the notice it ends in; an unknown path returns undefined. A failure becomes an error notice, never a rejected request. */
  async function act(path: string, form: URLSearchParams): Promise<Notice | undefined> {
    const field = (name: string) => form.get(name) ?? "";
    const id = field("id");
    try {
      switch (path) {
        case "/add": {
          const added = await connections.add({
            name: field("name"),
            url: field("url"),
            code: field("code"),
          });
          return { kind: "ok", text: `Added "${added.name}". Choose Connect to open it.` };
        }
        case "/connect":
          await connections.connect(id);
          const update = (await connections.list()).find((p) => p.id === id)?.update;
          return update
            ? {
                kind: "error",
                text: `Connected, but ${UPDATE_LABEL[update]}: the tray and notifications cannot follow this host.`,
              }
            : { kind: "ok", text: "Connected." };
        case "/forget": {
          const result = await connections.forget(id, {
            withoutRevoking: form.get("withoutRevoking") === "1",
          });
          if (result === "forgotten") return { kind: "ok", text: "Connection forgotten." };
          return {
            kind: "error",
            text: `${result.unreachable} The device stays valid on the host until it is revoked there.`,
            forgetWithoutRevoking: id,
          };
        }
      }
    } catch (error) {
      const text =
        error instanceof ConnectionError
          ? error.message
          : `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
      return {
        kind: "error",
        text,
        ...(path === "/add" && { form: { name: field("name"), url: field("url") } }),
      };
    }
    return undefined;
  }

  return {
    notice: (kind, text) => remember({ kind, text }),

    async handle(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        const m = url.searchParams.get("m");
        const html = pageHtml(await connections.list(), m === null ? undefined : notices.get(m));
        return respond(200, { "content-type": "text/html; charset=utf-8" }, html);
      }
      if (request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const done = await act(url.pathname, form);
        if (done !== undefined) return back(remember(done));
      }
      return respond(404, { "content-type": "text/plain; charset=utf-8" }, "not found");
    },
  };
}
