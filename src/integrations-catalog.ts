import type { CatalogInfo, IntegrationAuth, OwnClient } from "../web/events.ts";
import { ICONS } from "./integration-icons.ts";

/** A built-in service. Adding one means adding an entry here, not a new code path. */
export type CatalogEntry = CatalogInfo & {
  id: string;
  label: string;
  url: string;
  /** What the screen asks for; "none" until an auth flow for the service exists. */
  auth: IntegrationAuth;
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
  {
    id: "gmail", label: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", auth: { kind: "oauth", client: "own", ownClient: GMAIL_OAUTH },
    tagline: "Search, read and draft email", icon: ICONS.gmail,
    examples: ["Summarize my unread email from today", "Find the newest invoice in my inbox and tell me the total", "Draft a reply to my most recent email"],
  },
  {
    id: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", auth: { kind: "oauth", client: "dcr", alternative: { tokenLabel: "API key", tokenUrl: "https://linear.app/settings/account/security" } },
    tagline: "Issues, projects and triage", icon: ICONS.linear,
    examples: ["What is assigned to me this week?", "Triage the backlog and suggest priorities", "Summarize what my team closed in the last seven days"],
  },
  {
    id: "github", label: "GitHub", url: "https://api.githubcopilot.com/mcp/", auth: { kind: "bearer", tokenLabel: "Fine-grained personal access token", tokenUrl: "https://github.com/settings/personal-access-tokens/new", ownClient: GITHUB_OAUTH },
    tagline: "Repositories, issues and pull requests", icon: ICONS.github,
    examples: ["Which of my pull requests are waiting on review?", "Summarize the open issues labeled bug in my main repository"],
  },
  {
    id: "posthog", label: "PostHog", url: "https://mcp.posthog.com/mcp", auth: { kind: "oauth", client: "dcr", alternative: { tokenLabel: "Personal API key", tokenUrl: "https://app.posthog.com/settings/user-api-keys" } },
    tagline: "Product analytics and feature flags", icon: ICONS.posthog,
    examples: ["How did signups trend over the last 30 days?", "Which feature flags are rolled out to everyone?"],
  },
  {
    id: "cloudflare", label: "Cloudflare", url: "https://mcp.cloudflare.com/mcp", auth: { kind: "oauth", client: "dcr", alternative: { tokenLabel: "API token", tokenUrl: "https://dash.cloudflare.com/profile/api-tokens" } },
    tagline: "Workers, DNS, storage and logs", icon: ICONS.cloudflare, skillsRepo: "https://github.com/cloudflare/skills",
    examples: ["List my Workers and when each was last deployed", "Show the DNS records of my main zone"],
  },
];
