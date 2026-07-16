import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { EXIT_MS } from "../lib/use-exit-transition.js";

type Toast = { id: number; message: string; tone: "default" | "error"; exiting?: boolean };
type ToastFn = (message: string, tone?: "default" | "error") => void;

const ToastContext = createContext<ToastFn | null>(null);

let nextId = 1;

/** Most simultaneous toasts to keep on screen (newest win). */
const MAX_TOASTS = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Live dismiss timers, cleared on unmount — a timer firing after the provider
  // is gone calls setState on a dead tree (and crashes vitest's torn-down jsdom
  // with "window is not defined" as an unhandled error).
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const push = useCallback<ToastFn>((message, tone = "default") => {
    const id = nextId++;
    const arm = (fn: () => void, ms: number) => {
      const handle = setTimeout(() => {
        timersRef.current.delete(handle);
        fn();
      }, ms);
      timersRef.current.add(handle);
    };
    // Cap the stack so a burst of failures can't pile up off-screen.
    setToasts((t) => [...t, { id, message, tone }].slice(-MAX_TOASTS));
    arm(() => {
      // Two phase: mark exiting (data-state="closed" plays the exit anim), then
      // remove after the exit delay. Reduced-motion collapses the anim to ~0ms,
      // so the toast still clears promptly.
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, exiting: true } : x)));
      arm(() => setToasts((t) => t.filter((x) => x.id !== id)), EXIT_MS);
    }, 2600);
  }, []);

  const toastItem = (t: Toast) => (
    <div
      key={t.id}
      data-state={t.exiting ? "closed" : "open"}
      className={
        "cd-anim-toast pointer-events-auto rounded-lg border px-3.5 py-2 text-sm shadow-[var(--shadow-popover)] " +
        (t.tone === "error"
          ? "border-danger/30 bg-danger-subtle text-danger"
          : "border-border bg-surface-raised text-fg")
      }
    >
      {t.message}
    </div>
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* Two ALWAYS-present live regions, routed by tone. Errors interrupt the
          screen reader (role=alert / assertive); confirmations wait their turn
          (role=status / polite). Swapping a single region's role dynamically can
          make AT miss the new content, so we keep both mounted and stack them. */}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
        <div role="status" aria-live="polite" className="flex flex-col items-center gap-2">
          {toasts.filter((t) => t.tone !== "error").map(toastItem)}
        </div>
        <div role="alert" aria-live="assertive" className="flex flex-col items-center gap-2">
          {toasts.filter((t) => t.tone === "error").map(toastItem)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const fn = useContext(ToastContext);
  if (!fn) throw new Error("useToast must be used within ToastProvider");
  return fn;
}
