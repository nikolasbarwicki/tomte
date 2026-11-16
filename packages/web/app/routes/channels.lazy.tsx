import { createLazyRoute } from "@tanstack/react-router";

import { Channels } from "@/features/channels/index.ts";

export const Route = createLazyRoute("/channels")({ component: Channels });
