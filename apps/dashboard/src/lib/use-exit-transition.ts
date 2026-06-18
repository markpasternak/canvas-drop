import { useEffect, useRef, useState } from "react";

/** Delay before an overlay unmounts so its exit animation can play. Kept in sync
 *  with the longest `cd-anim-*[data-state="closed"]` duration in base.css. */
export const EXIT_MS = 150;

/**
 * Two-phase mount for overlays that should animate OUT, not just in.
 *
 * Given the caller's `open` flag, this keeps the element mounted for a short delay
 * after it closes so its exit keyframes (gated by `[data-state="closed"]`) can run,
 * then unmounts. Returns:
 *   - `mounted` — render the element while true (true on open, stays true through the
 *     exit delay)
 *   - `state` — `"open"` | `"closed"`, spread onto the animated node as `data-state`
 *
 * Reduced-motion safe: under `prefers-reduced-motion` the exit is instant (the delay
 * collapses to 0), matching the global animation-suppression — no lingering element.
 * Focus-trap/Escape behavior is unaffected: callers still own `open`; this only
 * defers the unmount.
 */
export function useExitTransition(open: boolean): {
  mounted: boolean;
  state: "open" | "closed";
} {
  const [mounted, setMounted] = useState(open);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduce) {
      setMounted(false);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      setMounted(false);
    }, EXIT_MS);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [open, mounted]);

  return { mounted, state: open ? "open" : "closed" };
}
