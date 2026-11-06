import { createLazyRoute } from "@tanstack/react-router";

import { Devices } from "@/features/devices/index.ts";

export const Route = createLazyRoute("/devices")({ component: Devices });
