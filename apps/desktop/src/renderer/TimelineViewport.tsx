import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { shouldFollowTimeline } from "./interaction-model.js";
import "./timeline-viewport.css";

/** A new project/task starts at its latest message, including an async history restore. */
interface TimelineProps { children: ReactNode; firstItemKey?: string | undefined; onReachTop?: (() => void) | undefined; }
export function TimelineViewport({ scopeKey, ...props }: TimelineProps & { scopeKey: string }) {
  return <ScopedTimelineViewport key={scopeKey} {...props} />;
}

function ScopedTimelineViewport({ children, firstItemKey, onReachTop }: TimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const automaticTopRef = useRef<number | undefined>(undefined);
  const [showJump, setShowJump] = useState(false);
  const previousLayout = useRef<{ first?: string | undefined; height: number; top: number } | undefined>(undefined);

  const updateLayout = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Instant movement prevents intermediate smooth-scroll events from pausing follow.
    if (followingRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      automaticTopRef.current = viewport.scrollTop;
    }
    const nearBottom = shouldFollowTimeline(viewport);
    if (nearBottom) followingRef.current = true;
    setShowJump(!nearBottom);
    if (previousLayout.current) {
      previousLayout.current.height = viewport.scrollHeight;
      previousLayout.current.top = viewport.scrollTop;
    }
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const previous = previousLayout.current;
    if (viewport && previous?.first && firstItemKey !== previous.first && !followingRef.current) {
      viewport.scrollTop = previous.top + viewport.scrollHeight - previous.height;
      automaticTopRef.current = viewport.scrollTop;
    }
    updateLayout();
    if (viewport) previousLayout.current = { first: firstItemKey, height: viewport.scrollHeight, top: viewport.scrollTop };
  }, [children, firstItemKey, updateLayout]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    // Content can resize without a new snapshot (for example, a collapsed tool).
    // The viewport also resizes when the composer or approval dock grows.
    const observer = new ResizeObserver(updateLayout);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [updateLayout]);

  const jumpToLatest = () => {
    followingRef.current = true;
    updateLayout();
    // Keep keyboard navigation in the conversation when its jump button disappears.
    viewportRef.current?.focus({ preventScroll: true });
  };

  return (
    <div className="timeline-viewport">
      <div
        className="timeline"
        ref={viewportRef}
        tabIndex={-1}
        aria-label="Task messages"
        onWheel={(event) => {
          // Record upward intent before a pending resize can pull the reader
          // back to the bottom, even if the scroll event has not fired yet.
          if (event.deltaY < 0) {
            followingRef.current = false;
            automaticTopRef.current = undefined;
          }
        }}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          // A scroll event from our last jump can arrive after another content
          // resize. It must not interpret the new bottom gap as a user gesture.
          if (automaticTopRef.current !== undefined
            && Math.abs(viewport.scrollTop - automaticTopRef.current) <= 1) return;
          automaticTopRef.current = undefined;
          const nearBottom = shouldFollowTimeline(viewport);
          followingRef.current = nearBottom;
          setShowJump(!nearBottom);
          if (previousLayout.current) previousLayout.current.top = viewport.scrollTop;
          if (viewport.scrollTop < 160 && !nearBottom) onReachTop?.();
        }}
      >
        <div className="timeline-content" ref={contentRef}>{children}</div>
      </div>
      {showJump ? (
        <button className="timeline-jump" type="button" onClick={jumpToLatest}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2.5v9m-3.5-3L8 12l3.5-3.5M3 14h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
