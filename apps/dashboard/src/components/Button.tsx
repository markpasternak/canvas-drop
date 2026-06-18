import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn.js";
import type { Size as ControlSize, Variant } from "./variants.js";

// Button renders only the two smaller sizes of the shared scale.
type Size = Extract<ControlSize, "sm" | "md">;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap " +
  "transition-all duration-100 [transition-timing-function:var(--ease-out)] active:translate-y-px " +
  "disabled:opacity-50 disabled:pointer-events-none select-none";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg shadow-[var(--shadow-xs)] hover:bg-accent-hover",
  secondary: "bg-surface-raised text-fg border border-border-strong hover:bg-surface-hover",
  ghost: "text-muted hover:text-fg hover:bg-surface-hover",
  danger: "bg-danger text-danger-fg hover:bg-danger-hover",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[0.8125rem]",
  md: "h-10 px-4 text-sm",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && (
        <>
          {/* The global reduced-motion block freezes this spinner, so it stops
              being a signal. The companion text below surfaces under reduced-motion
              only (cd-busy-text) so a frozen spinner is never the sole busy cue. */}
          <span
            aria-hidden
            className="cd-busy-spinner size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <span className="cd-busy-text sr-only">Working…</span>
        </>
      )}
      {children}
    </button>
  );
}
