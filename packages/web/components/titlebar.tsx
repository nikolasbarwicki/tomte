import { cn } from "@/lib/utils";

/**
 * An empty strip as tall as the native window controls' overlay, for the places that start at the window's top-left
 * (the sidebar, full-screen states). It is a drag region under the desktop app's hidden title bar and has no height
 * anywhere else.
 */
export function TitlebarStrip({ className }: { className?: string }) {
  return (
    <div
      data-titlebar
      aria-hidden
      className={cn("h-[env(titlebar-area-height,0px)] shrink-0", className)}
    />
  );
}
