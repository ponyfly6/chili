import { useEffect, useId, useRef } from "react";
import type { PointerEvent, ReactNode } from "react";
import { Icon } from "./Icon.js";
import "./sheet.css";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/** Keep children mounted while closed so dismissing a sheet preserves its draft. */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const backdropPointerRef = useRef<number | null>(null);

  function restoreFocus() {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog?.isConnected) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      restoreFocus();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      if (dialog?.open) dialog.close();
      restoreFocus();
    };
  }, []);

  function isBackdrop(event: PointerEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom;
  }

  return (
    <dialog
      ref={dialogRef}
      className="chili-sheet"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={() => { if (!dialogRef.current?.open) restoreFocus(); }}
      onPointerDown={(event) => { backdropPointerRef.current = isBackdrop(event) ? event.pointerId : null; }}
      onPointerUp={(event) => {
        const dismiss = backdropPointerRef.current === event.pointerId && isBackdrop(event);
        backdropPointerRef.current = null;
        if (dismiss) onClose();
      }}
      onPointerCancel={() => { backdropPointerRef.current = null; }}
    >
      <div className="chili-sheet-panel">
        <div className="chili-sheet-handle" aria-hidden="true" />
        <header className="chili-sheet-heading">
          <h2 className="chili-sheet-title" id={titleId}>{title}</h2>
          <button className="chili-sheet-close" type="button" aria-label="关闭" onClick={onClose} autoFocus>
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="chili-sheet-content">{children}</div>
      </div>
    </dialog>
  );
}
