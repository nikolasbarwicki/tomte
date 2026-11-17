import { createRootRoute, createRoute, createRouter, Navigate } from "@tanstack/react-router";
import { z } from "zod";

import { LINKED_PANELS, PANEL_SECTIONS, upgradePanel } from "@/lib/bot-panel.ts";

import { Shell } from "./shell.tsx";

/**
 * `panel`, `draft` and `draftEvent` are optional hints: a value that does not parse is dropped, never an error. `panel` is the
 * section the bot panel opens on; `section` only exists in links made when the panel had tabs, and is folded into `panel`.
 * `draftEvent` is the needs-you item a `draft` answers; the composer takes both at once, and the host checks the item is still open.
 */
const botSearch = z
  .object({
    panel: z.enum(LINKED_PANELS).optional().catch(undefined),
    section: z.enum(PANEL_SECTIONS).optional().catch(undefined),
    draft: z.string().optional().catch(undefined),
    draftEvent: z.string().optional().catch(undefined),
  })
  .transform(({ panel, section, ...rest }) => ({ ...rest, panel: upgradePanel(panel, section) }));

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
