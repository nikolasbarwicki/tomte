import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Sonner writes its stylesheet into an inline `<style>` element when its module loads, which the host's Content-Security-Policy
 * (`style-src 'self'`) blocks. The package ships the same CSS as `dist/styles.css`: drop the injection and import that file, so the
 * styles reach the page through the build's own stylesheet. Fails the build when sonner stops looking like this, so an upgrade
 * cannot silently bring the inline style back.
 */
const sonnerStylesheet = (): Plugin => ({
  name: "sonner-stylesheet",
  enforce: "pre",
  transform(code, id) {
    if (!/[\\/]sonner[\\/]dist[\\/]index\.mjs$/.test(id)) return;
    const withoutInjector = code
      .replace(/^function __insertCSS\(code\) \{[\s\S]*?^\}$/m, "")
      .replace(/^__insertCSS\(.*\);?$/m, 'import "./styles.css";');
    if (withoutInjector.includes("__insertCSS"))
      throw new Error(
        "sonner-stylesheet: sonner's inline style injection changed; update vite.config.ts",
      );
    return withoutInjector;
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), sonnerStylesheet()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  appType: "spa",
  build: {
    // Evaluate modules in import order across chunks, which `lib/zod-jitless.ts` relies on to run before any schema is built;
    // by default shared chunks run before the entry's own modules.
    rolldownOptions: { output: { strictExecutionOrder: true } },
  },
});
