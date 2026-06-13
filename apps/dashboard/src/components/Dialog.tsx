import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";

/**
 * Focus-trapped modal. Traps Tab within the panel, closes on Escape + backdrop
 * click, and restores focus to the element that opened it. Used directly (e.g.
 * the API-key reveal) and wrapped by ConfirmDialog.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  dismissable = true,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  dismissable?: boolean;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const autoId = useId();

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("[data-autofocus]")?.focus() ?? panel?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dismissable) {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, dismissable, onClose]);

  if (!open) return null;
  const titleId = labelledBy ?? autoId;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; keyboard users dismiss via Escape (handled in the keydown effect)
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[2px]" aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-md rounded-xl border border-border bg-surface-raised p-6 shadow-[var(--shadow-popover)] outline-none"
      >
        <h2 id={titleId} className="text-base font-semibold text-fg">
          {title}
        </h2>
        {description && <div className="mt-1.5 text-sm text-muted">{description}</div>}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
