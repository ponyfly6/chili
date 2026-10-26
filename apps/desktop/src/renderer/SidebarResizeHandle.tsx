import { useRef, useState, type PointerEvent } from "react";

interface SidebarResizeHandleProps {
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
  onReset: () => void;
}

export function SidebarResizeHandle({ width, minWidth, maxWidth, onResize, onReset }: SidebarResizeHandleProps) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const resize = (next: number) => onResize(Math.round(Math.min(maxWidth, Math.max(minWidth, next))));
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div
    className="sidebar-resize-handle"
    role="separator"
    tabIndex={0}
    aria-label="调整侧边栏宽度"
    aria-orientation="vertical"
    aria-controls="workspace-sidebar"
    aria-valuemin={minWidth}
    aria-valuemax={maxWidth}
    aria-valuenow={width}
    aria-valuetext={`${width} 像素`}
    title="拖动调整侧边栏宽度，双击恢复默认"
    data-dragging={dragging}
    onPointerDown={(event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, width };
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (start?.pointerId === event.pointerId) resize(start.width + event.clientX - start.x);
    }}
    onPointerUp={finishDrag}
    onPointerCancel={finishDrag}
    onLostPointerCapture={() => {
      drag.current = undefined;
      setDragging(false);
    }}
    onDoubleClick={onReset}
    onKeyDown={(event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const step = event.shiftKey ? 24 : 8;
      switch (event.key) {
        case "ArrowLeft": resize(width - step); break;
        case "ArrowRight": resize(width + step); break;
        case "Home": resize(minWidth); break;
        case "End": resize(maxWidth); break;
        case "Enter": onReset(); break;
        default: return;
      }
      event.preventDefault();
    }}
  />;
}
