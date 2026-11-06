import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";

import { ConfirmHost } from "@/components/confirm.tsx";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import { router } from "./app/router.tsx";
import { SessionGate } from "./app/session-gate.tsx";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <TooltipProvider>
      <SessionGate>
        <RouterProvider router={router} />
      </SessionGate>
      <ConfirmHost />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  </ThemeProvider>,
);
