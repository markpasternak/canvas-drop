import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useState } from "react";

type Toast = { id: number; message: string; tone: "default" | "error" };
type ToastFn = (message: string, tone?: "default" | "error") => void;

const ToastContext = createContext<ToastFn | null>(null);

let nextId = 1;

/** Most simultaneous toasts to keep on screen (newest win). */
const MAX_TOASTS = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback<ToastFn>((message, tone = "default") => {
    const id = nextId++;
    // Cap the stack so a burst of failures can't pile up off-screen.
    setToasts((t) => [...t, { id, message, tone }].slice(-MAX_TOASTS));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  // Errors interrupt the screen reader (assertive); confirmations wait their turn.
  const hasError = toasts.some((t) => t.tone === "error");

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* Live region so confirmations are announced to screen readers. */}
      <div
        className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2"
        role={hasError ? "alert" : "status"}
        aria-live={hasError ? "assertive" : "polite"}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              "cd-anim-toast pointer-events-auto rounded-lg border px-3.5 py-2 text-sm shadow-[var(--shadow-popover)] " +
              (t.tone === "error"
                ? "border-danger/30 bg-danger-subtle text-danger"
                : "border-border bg-surface-raised text-fg")
            }
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const fn = useContext(ToastContext);
  if (!fn) throw new Error("useToast must be used within ToastProvider");
  return fn;
}
