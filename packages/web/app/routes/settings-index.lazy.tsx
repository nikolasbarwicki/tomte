import { createLazyRoute, Navigate } from "@tanstack/react-router";

export const Route = createLazyRoute("/settings")({
  component: () => <Navigate to="/settings/$section" params={{ section: "general" }} replace />,
});
