import { createRootRoute, createRoute, createRouter, Navigate } from "@tanstack/react-router";
import { z } from "zod";

import { PANEL_TABS } from "@/features/bots/index.ts";

import { Shell } from "./shell.tsx";

/** `panel` and `draft` are optional hints: a value that does not parse is dropped, never an error. */
const botSearch = z.object({
  panel: z.enum(PANEL_TABS).optional().catch(undefined),
  draft: z.string().optional().catch(undefined),
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

const credentialsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/credentials",
}).lazy(() => import("./routes/credentials.lazy.tsx").then((d) => d.Route));

const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices",
}).lazy(() => import("./routes/devices.lazy.tsx").then((d) => d.Route));

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    botRoute,
    integrationsRoute,
    integrationRoute,
    credentialsRoute,
    devicesRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
