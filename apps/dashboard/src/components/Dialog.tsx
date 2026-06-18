import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { useExitTransition } from "../lib/use-exit-transition.js";

// Module-level ref-counted body-scroll lock. Overlapping dialogs would otherwise
// race on document.body.style.overflow: the first to close would restore the
// (already-hidden) value, leaving the body scrollable while a dialog is still open,
// or stranding `overflow: hidden` after all close. The count tracks open locks; we
// hide on the first acquire and restore the saved value on the last release.
let scrollLockCount = 0;
let savedBodyOverflow = "";
function acquireScrollLock() {
  if (scrollLockCount === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockCount += 1;
}
function releaseScrollLock() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = savedBodyOverflow;
  }
}

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
  // Read latest onClose/dismissable from refs so they stay OUT of the effect deps.
  // Otherwise a fresh onClose arrow on every parent render tears down and re-runs the
  // focus-trap + body-overflow effect each render — which, with a live CodeMirror
  // editor underneath, snowballs into a focus/measure loop that freezes the tab.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissableRef = useRef(dismissable);
  dismissableRef.current = dismissable;

  // Defer the unmount so the panel + scrim can animate OUT (data-state="closed")
  // before they leave the tree. Reduced-motion-safe (instant). The focus-trap +
  // body-overflow effect below stays keyed on the live `open`, so Escape/backdrop
  // dismissal and focus-restore behavior are unchanged.
  const { mounted, state } = useExitTransition(open);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("[data-autofocus]")?.focus() ?? panel?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dismissableRef.current) {
        onCloseRef.current();
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
    acquireScrollLock();
    return () => {
      document.removeEventListener("keydown", onKey);
      releaseScrollLock();
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;
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
      <div
        className="cd-anim-scrim absolute inset-0 bg-[var(--scrim)] backdrop-blur-[2px]"
        data-state={state}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-state={state}
        tabIndex={-1}
        className="cd-anim-pop relative w-full max-w-md rounded-xl border border-border bg-surface-raised p-6 shadow-[var(--shadow-popover)] outline-none"
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
