import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.js";

/** Default press-and-hold duration before the action fires. */
export const HOLD_MS = 1000;

/**
 * A destructive action that requires a deliberate press-and-hold instead of a
 * single click — the gesture is the confirmation, so no type-to-confirm gate is
 * needed. A fill sweeps the button over `holdMs`; releasing early cancels and
 * snaps it back. Works with pointer (mouse/touch) and keyboard: hold Enter or
 * Space to arm it, release to cancel.
 */
export function HoldButton({
  onComplete,
  loading = false,
  disabled = false,
  holdMs = HOLD_MS,
  children,
  className,
}: {
  onComplete: () => void;
  loading?: boolean;
  disabled?: boolean;
  holdMs?: number;
  children: ReactNode;
  className?: string;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards keyboard auto-repeat: a held Enter/Space fires keydown repeatedly,
  // but the hold must arm exactly once.
  const keyHeld = useRef(false);

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const start = () => {
    if (disabled || loading || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onComplete();
    }, holdMs);
  };

  const cancel = () => {
    clear();
    setHolding(false);
  };

  // Unmounting mid-hold (e.g. the dialog closes) must not fire the action.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !keyHeld.current) {
          e.preventDefault();
          keyHeld.current = true;
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          keyHeld.current = false;
          cancel();
        }
      }}
      onBlur={cancel}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "relative inline-flex h-8 items-center justify-center gap-2 overflow-hidden rounded-md px-3",
        "select-none whitespace-nowrap text-[0.8125rem] font-medium text-danger-fg",
        // No hover color-shift: it would mask the fill while you mouse-hold.
        "bg-danger",
        "disabled:pointer-events-none disabled:opacity-50",
        holding && "[&>.label]:scale-[0.97]",
        className,
      )}
    >
      {/* The progress fill. `danger-fg`-tinted so it reads in both themes (a light
          sweep on light mode, a dark sweep on dark) while the label stays legible. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-full origin-left bg-danger-fg/35"
        style={{
          transform: holding ? "scaleX(1)" : "scaleX(0)",
          transition: `transform ${holding ? holdMs : 150}ms linear`,
        }}
      />
      {loading && (
        <>
          <span
            aria-hidden
            className="cd-busy-spinner relative size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <span className="cd-busy-text sr-only">Working…</span>
        </>
      )}
      {/* Under reduced-motion the global block suppresses the sweeping fill above,
          so the hold has no visible progress. This text cue surfaces only under
          reduced-motion (cd-hold-cue) while holding, keeping the gesture legible;
          the JS timer is unaffected. */}
      {holding && (
        <span className="cd-hold-cue sr-only" aria-hidden>
          Holding…
        </span>
      )}
      <span className="label relative inline-flex items-center gap-2 transition-transform duration-150">
        {children}
      </span>
    </button>
  );
}
