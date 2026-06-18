import { X } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * Right-side slide-in drawer for the detail rail below the `xl` breakpoint (U3).
 * Mirrors the `Dialog` focus contract — moves focus into the panel on open, traps
 * Tab, closes on Escape + scrim click (restoring focus), and locks body scroll —
 * but presents as a full-height right sheet instead of a centered modal. The `xl`
 * inline rail renders the same `DetailPanel` directly without this chrome.
 *
 * `onClose` is what clears the selection on the route (Escape / scrim / the close
 * button all route through it), so closing the drawer drops `?selected`.
 */
export function DetailDrawer({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // Keep onClose out of the effect deps (a fresh arrow each render would tear down
  // and re-run the focus trap), mirroring Dialog.tsx.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("[data-autofocus]")?.focus() ?? panel?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
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
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: scrim click-to-dismiss; keyboard users dismiss via Escape (handled in the keydown effect)
    <div
      className="fixed inset-0 z-50 flex justify-end xl:hidden"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cd-anim-scrim absolute inset-0 bg-[var(--scrim)] backdrop-blur-[2px]"
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="cd-anim-sheet relative flex h-full w-full max-w-sm flex-col overflow-y-auto border-border border-l bg-surface shadow-[var(--shadow-popover)] outline-none"
      >
        <div className="flex justify-end p-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            data-autofocus
            className="inline-flex size-8 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <X size={18} weight="bold" aria-hidden />
          </button>
        </div>
        <div className="flex-1 px-3 pb-3">{children}</div>
      </div>
    </div>
  );
}
