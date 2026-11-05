import type { IntegrationAuth, OwnClient } from "../web/events.ts";

/** A built-in service. Adding one means adding an entry here, not a new code path. */
export type CatalogEntry = {
  id: string;
  label: string;
  url: string;
  /** What the card asks for; "none" until an auth flow for the service exists. */
  auth: IntegrationAuth;
  /** A note shown on the card. */
  note?: string;
  /** Git repository cloned for the skills this service brings. */
  skillsRepo?: string;
};

const GITHUB_OAUTH: OwnClient = {
  appLabel: "GitHub OAuth App",
  steps: [
    "Open GitHub Settings → Developer settings → OAuth Apps → New OAuth App.",
    "Set any name and homepage URL, and set the Authorization callback URL to the redirect address below.",
    "Register the application, then choose Generate a new client secret.",
    "Paste the Client ID and Client secret here and press Connect.",
  ],
};

const GMAIL_OAUTH: OwnClient = {
  appLabel: "Google OAuth client",
  scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
  steps: [
    "Join the Google Workspace Developer Preview Program with the Google account that owns the project.",
    "In Google Cloud Console, create or pick a project and enable both the Gmail API and the Gmail MCP API.",
    "Under Google Auth Platform → Branding/Audience, configure the consent screen.",
    "Choose Internal for a Workspace account. Otherwise choose External and add yourself as a test user; in Testing status Google expires refresh tokens after seven days, so you will sign in again weekly.",
    "Under Data Access add the scopes gmail.readonly and gmail.compose.",
    "Under Clients create a client of type Web application, mark it for an AI-powered agent, and add the redirect address below as an authorized redirect URI.",
    "Paste the Client ID and Client secret here and press Connect.",
  ],
};

export const CATALOG: readonly CatalogEntry[] = [
  { id: "gmail", label: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", auth: { kind: "oauth", client: "own", ownClient: GMAIL_OAUTH } },
  { id: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", auth: { kind: "oauth", client: "dcr", alternative: { tokenLabel: "API key", tokenUrl: "https://linear.app/settings/account/security" } } },
  { id: "github", label: "GitHub", url: "https://api.githubcopilot.com/mcp/", auth: { kind: "bearer", tokenLabel: "Fine-grained personal access token", tokenUrl: "https://github.com/settings/personal-access-tokens/new", ownClient: GITHUB_OAUTH } },
  { id: "posthog", label: "PostHog", url: "https://mcp.posthog.com/mcp", auth: { kind: "oauth", client: "dcr", alternative: { tokenLabel: "Personal API key", tokenUrl: "https://app.posthog.com/settings/user-api-keys" } } },
  { id: "cloudflare", label: "Cloudflare", url: "https://mcp.cloudflare.com/mcp", auth: { kind: "oauth", client: "dcr", alternative: { tokenLabel: "API token", tokenUrl: "https://dash.cloudflare.com/profile/api-tokens" } }, skillsRepo: "https://github.com/cloudflare/skills" },
];
