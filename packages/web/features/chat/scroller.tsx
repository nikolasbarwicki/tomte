import { ArrowDownIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState, type ReactNode, type WheelEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** How close to the end, in px, still counts as at the end: following resumes there and the button hides. */
const END_SLACK = 24;

const gapToEnd = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop;

/**
 * The transcript's scroll container. While the reader is at the end it follows it: anything that grows the content or shrinks the
 * viewport (a streamed reply, a new row, a taller composer) keeps the newest line in view. Only scrolling up stops following;
 * scrolling back to the end, or the button, resumes it. A new `followKey` (a message the user just sent) jumps to the end and
 * follows again.
 */
export function Scroller({
  followKey,
  busy,
  className,
  contentClassName,
  children,
}: {
  followKey: number;
  busy: boolean;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const [atEnd, setAtEnd] = useState(true);

  // A ResizeObserver callback runs after layout and before paint, so following never shows a frame short of the end.
  useLayoutEffect(() => {
    const el = viewport.current!;
    const observer = new ResizeObserver(() => {
      if (following.current) el.scrollTop = el.scrollHeight;
      setAtEnd(gapToEnd(el) <= END_SLACK);
    });
    observer.observe(el);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    following.current = true;
    viewport.current!.scrollTop = viewport.current!.scrollHeight;
  }, [followKey]);

  const onScroll = () => {
    const el = viewport.current!;
    const top = el.scrollTop;
    const gap = gapToEnd(el);
    // Moving up away from the end is the reader leaving it; content that shrinks clamps the position up but leaves it at the end.
    if (top < lastTop.current - 1 && gap > 1) following.current = false;
    else if (gap <= END_SLACK) following.current = true;
    lastTop.current = top;
    setAtEnd(gap <= END_SLACK);
  };
  // A wheel turn up says so before its scroll lands, which a follow in the same frame could otherwise undo.
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0 && e.currentTarget.scrollTop > 0) following.current = false;
  };
  const scrollToEnd = () => {
    following.current = true;
    viewport.current!.scrollTo({ top: viewport.current!.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className={cn("relative flex size-full min-h-0 flex-col overflow-hidden", className)}>
      <div
        ref={viewport}
        role="region"
        aria-label="Messages"
        tabIndex={0}
        onScroll={onScroll}
        onWheel={onWheel}
        className="scroll-fade-b size-full min-h-0 min-w-0 scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain"
      >
        <div
          ref={content}
          role="log"
          aria-relevant="additions"
          aria-busy={busy}
          className={cn("flex h-max min-h-full flex-col", contentClassName)}
        >
          {children}
        </div>
      </div>
      <Button
        variant="secondary"
        size="icon-sm"
        data-active={!atEnd}
        inert={atEnd}
        tabIndex={atEnd ? -1 : undefined}
        onClick={scrollToEnd}
        className="border-border bg-background text-foreground hover:bg-muted hover:text-foreground absolute bottom-4 left-1/2 -translate-x-1/2 transition-[translate,scale,opacity] duration-200 data-[active=false]:pointer-events-none data-[active=false]:translate-y-full data-[active=false]:scale-95 data-[active=false]:opacity-0"
      >
        <ArrowDownIcon />
        <span className="sr-only">Scroll to end</span>
      </Button>
    </div>
  );
}

/** One row of the transcript. `content-visibility: auto` skips rendering rows far off screen in a long transcript. */
export function ScrollerItem({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        "min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
        className,
      )}
    >
      {children}
    </div>
  );
}
