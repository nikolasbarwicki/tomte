"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

const SIDEBAR_STOP_STORAGE_KEY = "sidebar_stop";
const SIDEBAR_WIDTH_MOBILE = "18rem";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

/**
 * The desktop sidebar's widths. It is never hidden: dragging its edge settles on the nearest stop, and the narrowest is a
 * rail of bot faces, 76px wide so the macOS traffic lights over the desktop app's hidden title bar always sit over it.
 */
const SIDEBAR_STOPS = { rail: 76, names: 208, full: 320 } as const;
type SidebarStop = keyof typeof SIDEBAR_STOPS;
const STOP_ORDER: readonly SidebarStop[] = ["rail", "names", "full"];
const STOP_LABEL: Record<SidebarStop, string> = { rail: "Avatars", names: "Names", full: "Full" };
const SIDEBAR_DRAG_MAX = 380;

function nearestStop(width: number): SidebarStop {
  return STOP_ORDER.reduce((best, s) =>
    Math.abs(SIDEBAR_STOPS[s] - width) < Math.abs(SIDEBAR_STOPS[best] - width) ? s : best,
  );
}

function readStoredStop(): SidebarStop {
  try {
    const stored = localStorage.getItem(SIDEBAR_STOP_STORAGE_KEY);
    return STOP_ORDER.find((s) => s === stored) ?? "full";
  } catch {
    return "full";
  }
}

type SidebarContextProps = {
  /** The stop the sidebar shows; while its edge is dragged, the one nearest the pointer. */
  stop: SidebarStop;
  setStop: (stop: SidebarStop) => void;
  /** The edge's width while it is dragged, else null. */
  dragWidth: number | null;
  setDragWidth: (width: number | null) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  /** The rail and back on desktop, the sheet on phones. */
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

function SidebarProvider({ className, style, children, ...props }: React.ComponentProps<"div">) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [settled, setSettled] = React.useState(readStoredStop);
  // Where the rail opens back to.
  const [lastOpen, setLastOpen] = React.useState<SidebarStop>(() =>
    readStoredStop() === "names" ? "names" : "full",
  );
  const [dragWidth, setDragWidth] = React.useState<number | null>(null);

  const setStop = React.useCallback((next: SidebarStop) => {
    setSettled(next);
    if (next !== "rail") setLastOpen(next);
    try {
      localStorage.setItem(SIDEBAR_STOP_STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the stop lasts for this page only.
    }
  }, []);

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile((open) => !open);
    else setStop(settled === "rail" ? lastOpen : "rail");
  }, [isMobile, setStop, settled, lastOpen]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  const stop = dragWidth === null ? settled : nearestStop(dragWidth);
  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      stop,
      setStop,
      dragWidth,
      setDragWidth,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [stop, setStop, dragWidth, isMobile, openMobile, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        data-resizing={dragWidth !== null || undefined}
        style={
          {
            "--sidebar-width": `${dragWidth ?? SIDEBAR_STOPS[settled]}px`,
            ...style,
          } as React.CSSProperties
        }
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar data-resizing:cursor-col-resize data-resizing:select-none",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  minStop = "rail",
  className,
  style,
  children,
  dir,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  /** A narrower stop shows this one instead (a sidebar with no rail form). */
  minStop?: SidebarStop;
}) {
  const { isMobile, stop, openMobile, setOpenMobile } = useSidebar();

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          dir={dir}
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          className="bg-sidebar text-sidebar-foreground w-(--sidebar-width) p-0 [&>button]:hidden"
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
          side={side}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  const raised = STOP_ORDER.indexOf(stop) < STOP_ORDER.indexOf(minStop);
  return (
    <div
      className="group peer text-sidebar-foreground hidden md:block"
      data-stop={raised ? minStop : stop}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
      style={
        raised
          ? ({ "--sidebar-width": `${SIDEBAR_STOPS[minStop]}px`, ...style } as React.CSSProperties)
          : style
      }
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className="relative w-(--sidebar-width) bg-transparent transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] group-data-resizing/sidebar-wrapper:transition-none"
      />
      <div
        data-slot="sidebar-container"
        data-side={side}
        className={cn(
          "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] group-data-resizing/sidebar-wrapper:transition-none data-[side=left]:left-0 data-[side=right]:right-0 md:flex",
          // Adjust the padding for floating and inset variants.
          variant === "floating" || variant === "inset"
            ? "p-2"
            : "group-data-[side=left]:border-r group-data-[side=right]:border-l",
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="bg-sidebar group-data-[variant=floating]:ring-sidebar-border flex size-full flex-col group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:shadow-sm group-data-[variant=floating]:ring-1"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** Opens the sidebar's sheet on phones; on desktop the sidebar has no button, only its edge and ⌘B. */
function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className={cn("md:hidden", className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <SidebarSimpleIcon />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

/**
 * The sidebar's edge: drag it and the sidebar follows the pointer, then settles on the nearest stop. Double-click (or
 * Enter) goes to the rail and back; the arrow keys step between stops.
 */
function SidebarRail({ className, ...props }: React.ComponentProps<"div">) {
  const { stop, setStop, dragWidth, setDragWidth, toggleSidebar } = useSidebar();
  const drag = React.useRef<{ x: number; width: number } | null>(null);
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    if (dragWidth !== null) setStop(nearestStop(dragWidth));
    setDragWidth(null);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuemin={0}
      aria-valuemax={STOP_ORDER.length - 1}
      aria-valuenow={STOP_ORDER.indexOf(stop)}
      aria-valuetext={STOP_LABEL[stop]}
      tabIndex={0}
      title="Drag to resize · double-click or ⌘B to collapse"
      data-sidebar="rail"
      data-slot="sidebar-rail"
      data-dragging={dragWidth !== null || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const container = event.currentTarget.closest('[data-slot="sidebar-container"]');
        drag.current = {
          x: event.clientX,
          width: container?.getBoundingClientRect().width ?? SIDEBAR_STOPS[stop],
        };
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d) return;
        const delta =
          (event.clientX - d.x) * (event.currentTarget.closest("[data-side=right]") ? -1 : 1);
        if (dragWidth === null && Math.abs(delta) < 3) return;
        setDragWidth(Math.min(SIDEBAR_DRAG_MAX, Math.max(SIDEBAR_STOPS.rail, d.width + delta)));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={toggleSidebar}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const next = STOP_ORDER[STOP_ORDER.indexOf(stop) + (event.key === "ArrowLeft" ? -1 : 1)];
          if (next) setStop(next);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleSidebar();
        }
      }}
      className={cn(
        "group/rail absolute inset-y-0 z-20 hidden w-4 cursor-col-resize touch-none outline-hidden select-none group-data-[side=left]:-right-2 group-data-[side=right]:-left-2 sm:block",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="group-hover/rail:bg-foreground/15 group-focus-visible/rail:bg-ring group-data-dragging/rail:bg-foreground/25 absolute inset-y-4 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors duration-150"
      />
      {dragWidth !== null && (
        <span
          aria-hidden
          className="bg-foreground text-background absolute top-1/2 left-5 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap shadow-md"
        >
          {STOP_LABEL[stop]}
        </span>
      )}
    </div>
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        "relative flex w-full flex-1 flex-col bg-background md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn("h-8 w-full bg-background shadow-none", className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn("mx-2 w-auto bg-sidebar-border", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        "no-scrollbar flex min-h-0 flex-1 flex-col gap-0 overflow-auto group-data-[collapsible=icon]:overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      {...props}
    />
  );
}

function SidebarGroupLabel({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & React.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 ring-sidebar-ring outline-hidden transition-[margin,opacity] duration-200 ease-linear group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0 focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "sidebar-group-label",
      sidebar: "group-label",
    },
  });
}

function SidebarGroupAction({
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & React.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(
          "absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform group-data-[collapsible=icon]:hidden after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "sidebar-group-action",
      sidebar: "group-action",
    },
  });
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn("w-full text-sm", className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("flex w-full min-w-0 flex-col gap-0", className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button group/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm ring-sidebar-ring outline-hidden transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-open:hover:bg-sidebar-accent data-open:hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&>span:last-child]:truncate",
  {
    variants: {
      variant: {
        default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        outline:
          "bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]",
      },
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function SidebarMenuButton({
  render,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: useRender.ComponentProps<"button"> &
  React.ComponentProps<"button"> & {
    isActive?: boolean;
    tooltip?: string | React.ComponentProps<typeof TooltipContent>;
  } & VariantProps<typeof sidebarMenuButtonVariants>) {
  const { isMobile, stop } = useSidebar();
  const comp = useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(sidebarMenuButtonVariants({ variant, size }), className),
      },
      props,
    ),
    render: !tooltip ? render : <TooltipTrigger render={render} />,
    state: {
      slot: "sidebar-menu-button",
      sidebar: "menu-button",
      size,
      active: isActive,
    },
  });

  if (!tooltip) {
    return comp;
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip>
      {comp}
      <TooltipContent
        side="right"
        align="center"
        hidden={stop !== "rail" || isMobile}
        {...tooltip}
      />
    </Tooltip>
  );
}

function SidebarMenuAction({
  className,
  render,
  showOnHover = false,
  ...props
}: useRender.ComponentProps<"button"> &
  React.ComponentProps<"button"> & {
    showOnHover?: boolean;
  }) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(
          "absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform group-data-[collapsible=icon]:hidden peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0",
          showOnHover &&
            "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 peer-data-active/menu-button:text-sidebar-accent-foreground aria-expanded:opacity-100 md:opacity-0",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "sidebar-menu-action",
      sidebar: "menu-action",
    },
  });
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        "pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium text-sidebar-foreground tabular-nums select-none group-data-[collapsible=icon]:hidden peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 peer-data-active/menu-button:text-sidebar-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<"div"> & {
  showIcon?: boolean;
}) {
  // Random width between 50 to 90%.
  const [width] = React.useState(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`;
  });

  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn("flex h-8 items-center gap-2 rounded-md px-2", className)}
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            "--skeleton-width": width,
          } as React.CSSProperties
        }
      />
    </div>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5 group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn("group/menu-sub-item relative", className)}
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  render,
  size = "md",
  isActive = false,
  className,
  ...props
}: useRender.ComponentProps<"a"> &
  React.ComponentProps<"a"> & {
    size?: "sm" | "md";
    isActive?: boolean;
  }) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn(
          "flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground ring-sidebar-ring outline-hidden group-data-[collapsible=icon]:hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[size=md]:text-sm data-[size=sm]:text-xs data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "sidebar-menu-sub-button",
      sidebar: "menu-sub-button",
      size,
      active: isActive,
    },
  });
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
};
