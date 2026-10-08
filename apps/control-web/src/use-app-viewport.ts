import { useEffect } from "react";

interface ViewportMetrics { height: number; offsetTop: number; scale: number }
export interface ViewportFrame { height: number; top: number; bottom: number }
interface VerticalBounds { top: number; bottom: number }

/** Keyboard pan changes the visible origin as well as the available height. */
export function readViewportFrame(layoutHeight: number, viewport: ViewportMetrics | null): ViewportFrame | null {
  if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
  if (viewport && (viewport.scale !== 1 || !Number.isFinite(viewport.height) || viewport.height <= 0
    || !Number.isFinite(viewport.offsetTop))) return null;
  const height = Math.min(layoutHeight, viewport?.height ?? layoutHeight);
  const top = Math.max(0, viewport?.offsetTop ?? 0);
  return { height, top, bottom: Math.max(0, layoutHeight - height - top) };
}

export function focusedScrollDelta(frame: ViewportFrame, scroller: VerticalBounds, field: VerticalBounds): number {
  const top = Math.max(frame.top, scroller.top) + 12;
  const bottom = Math.min(frame.top + frame.height, scroller.bottom) - 12;
  if (bottom <= top) return 0;
  if (field.top < top) return field.top - top;
  return field.bottom > bottom ? field.bottom - bottom : 0;
}

/** One visible viewport frame for the page, its internal scrollers and dialogs. */
export function useAppViewport(): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let pendingFrame: number | null = null;

    const updateViewport = () => {
      const frame = readViewportFrame(window.innerHeight, viewport);
      if (!frame) return;
      root.style.setProperty("--app-height", `${frame.height}px`);
      root.style.setProperty("--app-top", `${frame.top}px`);
      root.style.setProperty("--app-bottom", `${frame.bottom}px`);
      if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = null;
        const focused = document.activeElement;
        if (!(focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || focused instanceof HTMLSelectElement)) return;
        const scroller = focused.closest<HTMLElement>(".pairing-view, .chili-sheet-content");
        if (!scroller) return;
        const delta = focusedScrollDelta(frame, scroller.getBoundingClientRect(), focused.getBoundingClientRect());
        if (delta !== 0) scroller.scrollTop += delta;
      });
    };

    updateViewport();
    window.addEventListener("resize", updateViewport);
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    document.addEventListener("focusin", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      document.removeEventListener("focusin", updateViewport);
      if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
      for (const name of ["--app-height", "--app-top", "--app-bottom"]) root.style.removeProperty(name);
    };
  }, []);
}
