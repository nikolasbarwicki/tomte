import { z } from "zod";

// Zod probes `new Function("")` to JIT its object parsers. A strict Content-Security-Policy (no `unsafe-eval`) blocks the probe and
// reports it as a violation even though zod catches the error, so turn the JIT off before any schema is built. `main.tsx` imports
// this module first, and `strictExecutionOrder` in `vite.config.ts` keeps the build from running shared chunks ahead of it.
z.config({ jitless: true });
