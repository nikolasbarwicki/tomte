import type { CatalogInfo, IntegrationAuth, OwnClient } from "@tomte/contract/events";

import { ICONS } from "./icons.ts";

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

const GOOGLE_APIS =
  "Gmail API and Gmail MCP API, Google Calendar API and Calendar MCP API, Google Sheets API and Sheets MCP API, Google Docs API and Docs MCP API, Google Drive API and Drive MCP API";

/** Every Google service shares this `appLabel`, so the client the user enters for one is reused by the rest. */
const googleClient = (scope: string): OwnClient => ({
  appLabel: "Google OAuth client",
  scope: scope
    .split(" ")
    .map((s) => `https://www.googleapis.com/auth/${s}`)
    .join(" "),
  steps: [
    "Join the Google Workspace Developer Preview Program with the Google account that owns the project.",
    `In Google Cloud Console, create or pick a project. For each Google service you connect, enable its API and its MCP API: ${GOOGLE_APIS}.`,
    "Under Google Auth Platform → Branding/Audience, configure the consent screen.",
    "Choose Internal for a Workspace account. Otherwise choose External and add yourself as a test user; in Testing status Google expires refresh tokens after seven days, so you will sign in again weekly.",
    `Under Data Access add the scopes ${scope.split(" ").join(", ")}.`,
    "Under Clients create one client of type Web application, mark it for an AI-powered agent, and add the redirect address below as an authorized redirect URI. Every Google service uses this client.",
    "Paste the Client ID and Client secret here and press Connect. If another Google service is already connected, leave both empty to reuse its client.",
  ],
});

const SLACK_APP: OwnClient = {
  appLabel: "Slack app",
  scope:
    "search:read.public channels:history groups:history im:history mpim:history chat:write canvases:read canvases:write users:read",
  steps: [
    "Open api.slack.com/apps and create a new app from scratch in your workspace.",
    "Under Agents, turn on Slack Model Context Protocol (MCP) Server.",
    "Under OAuth & Permissions, add the redirect address below and the user token scopes search:read.public, channels:history, groups:history, im:history, mpim:history, chat:write, canvases:read, canvases:write and users:read.",
    "Install the app to the workspace; a workspace admin may have to approve it.",
    "Under Basic Information copy the Client ID and Client secret, paste them here and press Connect.",
  ],
};

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "gmail",
    label: "Gmail",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    auth: { kind: "oauth", client: "own", ownClient: googleClient("gmail.readonly gmail.compose") },
    category: "Communication",
    tagline: "Search, read and draft email",
    icon: ICONS.gmail,
    examples: [
      "Summarize my unread email from today",
      "Find the newest invoice in my inbox and tell me the total",
      "Draft a reply to my most recent email",
    ],
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    auth: {
      kind: "oauth",
      client: "own",
      ownClient: googleClient(
        "calendar.calendarlist.readonly calendar.events.freebusy calendar.events",
      ),
    },
    category: "Productivity",
    tagline: "Events, availability and invitations",
    icon: ICONS.googleCalendar,
    examples: [
      "What is on my calendar tomorrow?",
      "Find a free hour this week for a call with Anna",
      "Create a 30-minute focus block on Friday morning",
    ],
  },
  {
    id: "google-sheets",
    label: "Google Sheets",
    url: "https://sheetsmcp.googleapis.com/mcp/v1",
    auth: {
      kind: "oauth",
      client: "own",
      ownClient: googleClient("drive.readonly drive.file spreadsheets"),
    },
    category: "Productivity",
    tagline: "Read and update spreadsheets",
    icon: ICONS.googleSheets,
    examples: [
      "Sum the totals column of my budget spreadsheet",
      "Add a row for today's expenses to my tracker sheet",
    ],
  },
  {
    id: "google-docs",
    label: "Google Docs",
    url: "https://docsmcp.googleapis.com/mcp/v1",
    auth: {
      kind: "oauth",
      client: "own",
      ownClient: googleClient("drive.readonly drive.file documents"),
    },
    category: "Productivity",
    tagline: "Read and edit documents",
    icon: ICONS.googleDocs,
    examples: [
      "Summarize my latest meeting notes doc",
      "Append today's action items to the project plan doc",
    ],
  },
  {
    id: "google-drive",
    label: "Google Drive",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    auth: { kind: "oauth", client: "own", ownClient: googleClient("drive.readonly drive.file") },
    category: "Productivity",
    tagline: "Search, read and create files",
    icon: ICONS.googleDrive,
    examples: [
      "Which files did I edit this week?",
      "Find the latest contract PDF and summarize it",
      "Create a copy of the onboarding template for Sam",
    ],
  },
  {
    id: "slack",
    label: "Slack",
    url: "https://mcp.slack.com/mcp",
    auth: { kind: "oauth", client: "own", ownClient: SLACK_APP },
    category: "Communication",
    tagline: "Search channels, read threads and post messages",
    icon: ICONS.slack,
    examples: [
      "Summarize what happened in #general today",
      "Find the thread where we decided on the launch date",
      "Post a short status update in #team",
    ],
  },
  {
    id: "resend",
    label: "Resend",
    url: "https://mcp.resend.com/mcp",
    auth: {
      kind: "oauth",
      client: "dcr",
      alternative: { tokenLabel: "API key", tokenUrl: "https://resend.com/api-keys" },
    },
    category: "Communication",
    tagline: "Transactional email, domains and contacts",
    icon: ICONS.resend,
    examples: [
      "List my verified sending domains",
      "Send a test email to me from my default domain",
    ],
  },
  {
    id: "mailerlite",
    label: "MailerLite",
    url: "https://mcp.mailerlite.com/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Communication",
    tagline: "Subscribers, groups and campaigns",
    icon: ICONS.mailerlite,
    examples: [
      "How did my last campaign perform?",
      "How many subscribers joined this month?",
      "Draft a campaign announcing the new release",
    ],
  },
  {
    id: "linear",
    label: "Linear",
    url: "https://mcp.linear.app/mcp",
    auth: {
      kind: "oauth",
      client: "dcr",
      alternative: {
        tokenLabel: "API key",
        tokenUrl: "https://linear.app/settings/account/security",
      },
    },
    category: "Engineering",
    tagline: "Issues, projects and triage",
    icon: ICONS.linear,
    examples: [
      "What is assigned to me this week?",
      "Triage the backlog and suggest priorities",
      "Summarize what my team closed in the last seven days",
    ],
  },
  {
    id: "github",
    label: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    auth: {
      kind: "bearer",
      tokenLabel: "Fine-grained personal access token",
      tokenUrl: "https://github.com/settings/personal-access-tokens/new",
      ownClient: GITHUB_OAUTH,
    },
    category: "Engineering",
    tagline: "Repositories, issues and pull requests",
    icon: ICONS.github,
    examples: [
      "Which of my pull requests are waiting on review?",
      "Summarize the open issues labeled bug in my main repository",
    ],
  },
  {
    id: "posthog",
    label: "PostHog",
    url: "https://mcp.posthog.com/mcp",
    auth: {
      kind: "oauth",
      client: "dcr",
      alternative: {
        tokenLabel: "Personal API key",
        tokenUrl: "https://app.posthog.com/settings/user-api-keys",
      },
    },
    category: "Engineering",
    tagline: "Product analytics and feature flags",
    icon: ICONS.posthog,
    examples: [
      "How did signups trend over the last 30 days?",
      "Which feature flags are rolled out to everyone?",
    ],
  },
  {
    id: "sentry",
    label: "Sentry",
    url: "https://mcp.sentry.dev/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Engineering",
    tagline: "Errors, issues and releases",
    icon: ICONS.sentry,
    examples: [
      "What are the top unresolved errors this week?",
      "Explain the stack trace of the newest issue in my main project",
      "Resolve the issue we just fixed",
    ],
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    url: "https://mcp.cloudflare.com/mcp",
    auth: {
      kind: "oauth",
      client: "dcr",
      alternative: {
        tokenLabel: "API token",
        tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
      },
    },
    category: "Cloud and data",
    tagline: "Workers, DNS, storage and logs",
    icon: ICONS.cloudflare,
    skillsRepo: "https://github.com/cloudflare/skills",
    examples: [
      "List my Workers and when each was last deployed",
      "Show the DNS records of my main zone",
    ],
  },
  {
    id: "vercel",
    label: "Vercel",
    url: "https://mcp.vercel.com",
    auth: { kind: "oauth", client: "dcr" },
    category: "Cloud and data",
    tagline: "Projects, deployments and logs",
    icon: ICONS.vercel,
    examples: [
      "Did my latest deployment succeed?",
      "Show the build logs of the last failed deployment",
    ],
  },
  {
    id: "netlify",
    label: "Netlify",
    url: "https://netlify-mcp.netlify.app/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Cloud and data",
    tagline: "Sites, deploys and environment variables",
    icon: ICONS.netlify,
    examples: [
      "List my sites and their last deploy status",
      "Deploy the current folder as a new site",
    ],
  },
  {
    id: "railway",
    label: "Railway",
    url: "https://mcp.railway.com/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Cloud and data",
    tagline: "Projects, services and deployments",
    icon: ICONS.railway,
    examples: [
      "Which of my Railway services are running?",
      "Show the latest deploy logs of my API service",
    ],
  },
  {
    id: "render",
    label: "Render",
    url: "https://mcp.render.com/mcp",
    auth: {
      kind: "bearer",
      tokenLabel: "API key",
      tokenUrl: "https://dashboard.render.com/u/settings#api-keys",
    },
    category: "Cloud and data",
    tagline: "Services, databases and logs",
    icon: ICONS.render,
    examples: [
      "List my Render services and their status",
      "Show the error logs of my web service from the last hour",
    ],
  },
  {
    id: "supabase",
    label: "Supabase",
    url: "https://mcp.supabase.com/mcp",
    auth: {
      kind: "oauth",
      client: "dcr",
      alternative: {
        tokenLabel: "Personal access token",
        tokenUrl: "https://supabase.com/dashboard/account/tokens",
      },
    },
    category: "Cloud and data",
    tagline: "Postgres projects, SQL and edge functions",
    icon: ICONS.supabase,
    examples: [
      "List the tables in my main project",
      "How many users signed up yesterday?",
      "Create a migration that adds an index on orders.created_at",
    ],
  },
  {
    id: "neon",
    label: "Neon",
    url: "https://mcp.neon.tech/mcp",
    auth: {
      kind: "oauth",
      client: "dcr",
      alternative: {
        tokenLabel: "API key",
        tokenUrl: "https://console.neon.tech/app/settings/api-keys",
      },
    },
    category: "Cloud and data",
    tagline: "Serverless Postgres projects and branches",
    icon: ICONS.neon,
    examples: [
      "List my Neon projects and their branches",
      "Run a query counting rows in the users table",
      "Create a branch for testing a schema change",
    ],
  },
  {
    id: "notion",
    label: "Notion",
    url: "https://mcp.notion.com/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Productivity",
    tagline: "Pages, databases and comments",
    icon: ICONS.notion,
    examples: [
      "Find my notes about the Q3 roadmap",
      "Summarize the pages my team edited this week",
      "Create a page with today's meeting notes",
    ],
  },
  {
    id: "atlassian",
    label: "Atlassian",
    url: "https://mcp.atlassian.com/v1/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Productivity",
    tagline: "Jira issues and Confluence pages",
    icon: ICONS.atlassian,
    examples: [
      "Which Jira issues are assigned to me?",
      "Summarize the Confluence page about our release process",
      "Create a Jira bug for the login timeout",
    ],
  },
  {
    id: "todoist",
    label: "Todoist",
    url: "https://ai.todoist.net/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Productivity",
    tagline: "Tasks, projects and due dates",
    icon: ICONS.todoist,
    examples: ["What is due today?", "Add a task to call the dentist tomorrow at 10"],
  },
  {
    id: "ticktick",
    label: "TickTick",
    url: "https://mcp.ticktick.com",
    auth: {
      kind: "oauth",
      client: "dcr",
      alternative: {
        tokenLabel: "API token",
        tokenUrl: "https://ticktick.com/webapp/#settings/account",
      },
    },
    category: "Productivity",
    tagline: "Tasks, lists and due dates",
    icon: ICONS.ticktick,
    examples: [
      "What tasks do I have today?",
      "Add a high-priority task to prepare the meeting deck tomorrow at 3pm",
    ],
  },
  {
    id: "clickup",
    label: "ClickUp",
    url: "https://mcp.clickup.com/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Productivity",
    tagline: "Tasks, docs and comments",
    icon: ICONS.clickup,
    examples: [
      "Which ClickUp tasks are overdue?",
      "Create a task for the design review in my current list",
    ],
  },
  {
    id: "airtable",
    label: "Airtable",
    url: "https://mcp.airtable.com/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Productivity",
    tagline: "Bases, tables and records",
    icon: ICONS.airtable,
    examples: [
      "List the bases I can access",
      "Show the records in my content calendar due this week",
      "Add a record for the new lead",
    ],
  },
  {
    id: "stripe",
    label: "Stripe",
    url: "https://mcp.stripe.com",
    auth: {
      kind: "oauth",
      client: "dcr",
      alternative: {
        tokenLabel: "Restricted key (rk_…)",
        tokenUrl: "https://dashboard.stripe.com/apikeys",
      },
    },
    category: "Sales and payments",
    tagline: "Payments, customers and subscriptions",
    icon: ICONS.stripe,
    examples: [
      "What was my revenue last month?",
      "Which subscriptions failed to renew this week?",
      "Create a payment link for the consulting package",
    ],
  },
  {
    id: "intercom",
    label: "Intercom",
    url: "https://mcp.intercom.com/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Sales and payments",
    tagline: "Customer conversations and contacts",
    icon: ICONS.intercom,
    examples: [
      "Summarize today's open conversations",
      "Find every conversation with the customer from Acme",
    ],
  },
  {
    id: "clay",
    label: "Clay",
    url: "https://api.clay.com/v3/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Sales and payments",
    tagline: "Find and enrich companies and contacts",
    icon: ICONS.clay,
    examples: [
      "What tables are in my Clay workspace?",
      "Enrich the company acme.com with its headcount and industry",
    ],
  },
  {
    id: "canva",
    label: "Canva",
    url: "https://mcp.canva.com/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Design",
    tagline: "Designs, folders and exports",
    icon: ICONS.canva,
    examples: [
      "Find my latest presentation design",
      "Export my newest social post design as PNG",
      "Create an Instagram post announcing the launch",
    ],
  },
  {
    id: "mobbin",
    label: "Mobbin",
    url: "https://api.mobbin.com/mcp",
    auth: { kind: "oauth", client: "dcr" },
    category: "Design",
    tagline: "Real-world app screens and flows for reference",
    icon: ICONS.mobbin,
    examples: [
      "Show onboarding flows from fintech apps",
      "Find examples of paywall screens",
      "Save the best checkout screens to a new collection",
    ],
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    url: "https://mcp.firecrawl.dev/v2/mcp",
    auth: {
      kind: "bearer",
      tokenLabel: "API key (fc-…)",
      tokenUrl: "https://www.firecrawl.dev/app/api-keys",
    },
    category: "Web",
    tagline: "Scrape, crawl and search the web",
    icon: ICONS.firecrawl,
    examples: [
      "Scrape the pricing page of example.com into markdown",
      "Search the web for recent posts about MCP security",
    ],
  },
];
