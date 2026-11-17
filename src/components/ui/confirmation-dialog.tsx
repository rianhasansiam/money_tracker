"use client";

import { useEffect, useLayoutEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ConfirmationDialog({ open, busy, title, description, onClose, children, closeLabel = "Close quarantine confirmation", contentClassName, initialFocusRef, onOpenFocus }: {
  open: boolean; busy: boolean; title: string; description: string; onClose: () => void; children: ReactNode;
  closeLabel?: string; contentClassName?: string; initialFocusRef?: RefObject<HTMLElement | null>;
  onOpenFocus?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const id = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    if (open && !dialog.open) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      document.body.style.overflow = "hidden";
      initialFocusRef?.current?.focus({ preventScroll: true });
      onOpenFocus?.();
    } else if (!open && dialog.open) {
      dialog.close();
      previousFocus.current?.focus();
    }
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, [open, initialFocusRef, onOpenFocus]);
  useEffect(() => {
    const dialog = dialogRef.current;
    // Disabling the focused submit button can move browser focus to the body.
    // Keep keyboard events in the modal while the request is pending.
    if (open && busy && dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, [open, busy]);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const viewport = window.visualViewport;
    function fitVisibleViewport() {
      if (!dialog) return;
      dialog.style.setProperty("--dialog-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      dialog.style.setProperty("--dialog-viewport-top", `${viewport?.offsetTop ?? 0}px`);
      const active = document.activeElement;
      if (active instanceof HTMLElement && dialog.contains(active) && active.matches("input, textarea, select")) active.scrollIntoView({ block: "nearest" });
    }
    fitVisibleViewport();
    viewport?.addEventListener("resize", fitVisibleViewport);
    viewport?.addEventListener("scroll", fitVisibleViewport);
    window.addEventListener("resize", fitVisibleViewport);
    return () => {
      viewport?.removeEventListener("resize", fitVisibleViewport);
      viewport?.removeEventListener("scroll", fitVisibleViewport);
      window.removeEventListener("resize", fitVisibleViewport);
      dialog?.style.removeProperty("--dialog-viewport-height");
      dialog?.style.removeProperty("--dialog-viewport-top");
    };
  }, [open]);
  return (
    <dialog ref={dialogRef} tabIndex={-1} className="confirmation-dialog" aria-modal="true" aria-busy={busy} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const dialog = event.currentTarget;
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]"))
          .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === dialog)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (active === last || active === dialog)) { event.preventDefault(); first.focus(); }
      }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className={cn("max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-xl border border-border bg-card p-5 shadow-xl sm:p-6", contentClassName)}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-xl font-semibold">{title}</h2>
            <p id={`${id}-description`} className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label={closeLabel} disabled={busy} onClick={onClose}><X aria-hidden="true" /></Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
