import { createRootRoute, createRoute, createRouter, Navigate } from "@tanstack/react-router";
import { z } from "zod";

import { BOT_SECTIONS, PANEL_TABS } from "@/features/bots/index.ts";

import { Shell } from "./shell.tsx";

/**
 * `panel`, `section`, `draft` and `draftEvent` are optional hints: a value that does not parse is dropped, never an error.
 * `section` is a page under the panel's Settings tab. `draftEvent` is the needs-you item a `draft` answers; the composer
 * takes both at once, and the host checks the item is still open.
 */
const botSearch = z.object({
  panel: z.enum(PANEL_TABS).optional().catch(undefined),
  section: z.enum(BOT_SECTIONS).optional().catch(undefined),
  draft: z.string().optional().catch(undefined),
  draftEvent: z.string().optional().catch(undefined),
});

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: () => <Navigate to="/" replace />,
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" }).lazy(() =>
  import("./routes/index.lazy.tsx").then((d) => d.Route),
);

const botRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bots/$botId",
  validateSearch: botSearch,
}).lazy(() => import("./routes/bot.lazy.tsx").then((d) => d.Route));

const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integrations",
}).lazy(() => import("./routes/integrations.lazy.tsx").then((d) => d.Route));

const integrationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integrations/$integrationId",
}).lazy(() => import("./routes/integration.lazy.tsx").then((d) => d.Route));

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
}).lazy(() => import("./routes/settings-index.lazy.tsx").then((d) => d.Route));

const settingsSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$section",
}).lazy(() => import("./routes/settings.lazy.tsx").then((d) => d.Route));

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    botRoute,
    integrationsRoute,
    integrationRoute,
    settingsRoute,
    settingsSectionRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
