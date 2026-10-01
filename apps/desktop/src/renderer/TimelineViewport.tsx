import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { shouldFollowTimeline } from "./interaction-model.js";
import "./timeline-viewport.css";

/** A new project/task starts at its latest message, including an async history restore. */
export function TimelineViewport({ scopeKey, children }: { scopeKey: string; children: ReactNode }) {
  return <ScopedTimelineViewport key={scopeKey}>{children}</ScopedTimelineViewport>;
}

function ScopedTimelineViewport({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const automaticTopRef = useRef<number | undefined>(undefined);
  const [showJump, setShowJump] = useState(false);

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
  }, []);

  useLayoutEffect(updateLayout, [children, updateLayout]);

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
