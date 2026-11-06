import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import { ConfirmHost } from "./confirm.tsx";
import { router } from "./router.tsx";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <TooltipProvider>
      <RouterProvider router={router} />
      <ConfirmHost />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  </ThemeProvider>,
);
