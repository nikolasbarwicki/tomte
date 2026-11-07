import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/** A fake authorization server and a protected MCP server on one origin: discovery, DCR, PKCE code exchange, refresh. */
export function oauthFixture(own?: { id: string; secret: string }) {
  let registrations = 0;
  const redirects: string[][] = [];
  const codes = new Map<string, { challenge: string; clientId: string }>();
  const live = new Set<string>();
  const refreshes = new Set<string>();
  let n = 0;
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const origin = u.origin;
      const j = (v: unknown, status = 200) => Response.json(v, { status });
      if (u.pathname === "/.well-known/oauth-protected-resource/mcp")
        return j({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      if (u.pathname === "/.well-known/oauth-authorization-server")
        return j({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(!own && { registration_endpoint: `${origin}/register` }),
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: own ? ["client_secret_post"] : ["none"],
        });
      if (u.pathname === "/register") {
        registrations++;
        const meta = (await req.json()) as { redirect_uris: string[] };
        redirects.push(meta.redirect_uris);
        return j({ ...meta, client_id: `client-${++n}` }, 201);
      }
      if (u.pathname === "/token") {
        const f = new URLSearchParams(await req.text());
        if (own && (f.get("client_id") !== own.id || f.get("client_secret") !== own.secret))
          return j(
            { error: "invalid_client", error_description: "The client credentials are incorrect" },
            401,
          );
        const issue = () => {
          const access = `at-${++n}`;
          live.add(access);
          const refresh = `rt-${n}`;
          refreshes.add(refresh);
          return j({
            access_token: access,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: refresh,
          });
        };
        if (f.get("grant_type") === "refresh_token")
          return refreshes.delete(f.get("refresh_token") ?? "")
            ? issue()
            : j({ error: "invalid_grant" }, 400);
        const c = codes.get(f.get("code") ?? "");
        codes.delete(f.get("code") ?? "");
        const verifier = f.get("code_verifier") ?? "";
        const digest = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
        if (!c || c.challenge !== digest) return j({ error: "invalid_grant" }, 400);
        return issue();
      }
      if (u.pathname === "/mcp") {
        const bearer = req.headers.get("authorization")?.slice(7) ?? "";
        if (!live.has(bearer))
          return new Response("no", {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
        mcp.registerTool(
          "lookup",
          { description: "x", annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "ok" }] }),
        );
        mcp.registerTool(
          "delete_all",
          { description: "x", annotations: { destructiveHint: true } },
          async () => ({ content: [{ type: "text", text: "gone" }] }),
        );
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        await mcp.connect(transport);
        return transport.handleRequest(req);
      }
      return new Response("nope", { status: 404 });
    },
  });
  /** What the browser does at the authorize URL: approve and return the redirect's query. */
  const approve = (authorizeUrl: string) => {
    const a = new URL(authorizeUrl);
    const code = `code-${++n}`;
    codes.set(code, {
      challenge: a.searchParams.get("code_challenge")!,
      clientId: a.searchParams.get("client_id")!,
    });
    return { a, code, state: a.searchParams.get("state")! };
  };
  return {
    server: s,
    url: `http://127.0.0.1:${s.port}/mcp`,
    approve,
    registrations: () => registrations,
    /** The `redirect_uris` of each client registration the server received, oldest first. */
    registeredRedirects: () => redirects,
    expireAll: () => live.clear(),
  };
}
