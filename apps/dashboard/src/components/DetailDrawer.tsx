import { X } from "@phosphor-icons/react";
import { type ReactNode, useRef } from "react";
import { useExitTransition } from "../lib/use-exit-transition.js";
import { useModalLayer } from "../lib/use-modal-layer.js";

/**
 * Right-side slide-in drawer for the detail rail below the `2xl` breakpoint (U3).
 * Mirrors the `Dialog` focus contract — moves focus into the panel on open, traps
 * Tab, closes on Escape + scrim click (restoring focus), and locks body scroll —
 * but presents as a full-height right sheet instead of a centered modal. The `2xl`
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
  // Two-phase mount so the sheet animates OUT (slide back to the right) before it
  // unmounts, the way Dialog/CommandPalette do — the focus-trap/Escape/restore
  // effect stays keyed on the live `open`, not on `mounted`.
  const { mounted, state } = useExitTransition(open);
  // The parent clears its selection on close, so `children` go to the empty state
  // the instant `open` flips false. Hold the last open content through the exit so
  // the sheet slides out showing what it had, not a flash of "select a canvas".
  const childrenRef = useRef<ReactNode>(children);
  if (open) childrenRef.current = children;
  const { isTop } = useModalLayer({ open, panelRef, onClose });

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end 2xl:hidden" role="presentation">
      {/* The scrim is the sole dismissal layer: it sits above this container in the
          stacking order and covers it, so an outside click always lands on the scrim
          (not here). Close from the scrim's own mousedown so clicking the backdrop
          dismisses the drawer + clears selection. (Don't add an onMouseDown to this
          container — it would be dead today and double-fire onClose if a gap ever
          appeared.) */}
      <div
        className="cd-anim-scrim absolute inset-0 bg-[var(--scrim)] backdrop-blur-[2px]"
        data-state={state}
        aria-hidden
        onMouseDown={(e) => {
          if (isTop() && e.target === e.currentTarget) onClose();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-state={state}
        className="cd-anim-sheet relative flex h-full w-full max-w-sm flex-col overflow-y-auto border-border border-l bg-surface shadow-[var(--shadow-popover)] outline-none"
      >
        <div className="flex justify-end p-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            data-autofocus
            className="cd-touch-target inline-flex size-8 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <X size={18} weight="bold" aria-hidden />
          </button>
        </div>
        <div className="flex-1 px-3 pb-3">{open ? children : childrenRef.current}</div>
      </div>
    </div>
  );
}
