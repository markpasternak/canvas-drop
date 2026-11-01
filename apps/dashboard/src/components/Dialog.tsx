import type { ReactNode } from "react";
import { useId, useRef } from "react";
import { useExitTransition } from "../lib/use-exit-transition.js";
import { useModalLayer } from "../lib/use-modal-layer.js";

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
  placement = "center",
  closeLabel = "Close panel",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  dismissable?: boolean;
  labelledBy?: string;
  placement?: "center" | "side";
  closeLabel?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const autoId = useId();
  const { mounted, state } = useExitTransition(open);
  const { isTop } = useModalLayer({ open, panelRef, onClose, dismissable });

  if (!mounted) return null;
  const titleId = labelledBy ?? autoId;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; keyboard users dismiss via Escape (handled in the keydown effect)
    <div
      className={
        placement === "side"
          ? "fixed inset-0 z-50 flex justify-end"
          : "fixed inset-0 z-50 flex items-center justify-center p-4"
      }
      role="presentation"
      onMouseDown={(e) => {
        if (dismissable && isTop() && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cd-anim-scrim pointer-events-none absolute inset-0 bg-[var(--scrim)] backdrop-blur-[2px]"
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
        className={
          placement === "side"
            ? "cd-anim-pop relative flex h-dvh w-full max-w-2xl flex-col overflow-hidden border-l border-border bg-surface-raised shadow-[var(--shadow-popover)] outline-none"
            : "cd-anim-pop relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface-raised p-6 shadow-[var(--shadow-popover)] outline-none"
        }
      >
        <div
          className={
            placement === "side" ? "shrink-0 border-b border-border p-5 sm:px-7" : undefined
          }
        >
          <div className="flex items-start justify-between gap-3">
            <h2 id={titleId} className="min-w-0 break-words text-base font-semibold text-fg">
              {title}
            </h2>
            {placement === "side" && (
              <button
                type="button"
                disabled={!dismissable}
                onClick={onClose}
                aria-label={closeLabel}
                className="min-h-11 shrink-0 rounded-md px-3 py-1 text-sm text-muted hover:bg-surface-hover disabled:opacity-50"
              >
                Close
              </button>
            )}
          </div>
          {description && <div className="mt-1.5 text-sm text-muted">{description}</div>}
        </div>
        <div
          className={
            placement === "side"
              ? "min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-7"
              : "mt-4"
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}
