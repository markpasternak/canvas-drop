import type { ReactNode } from "react";
import { useId } from "react";
import { cn } from "../lib/cn.js";

/** Accessible switch with a label + optional description, token-styled. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  // A <label htmlFor> only names labelable elements (input/select/…), NOT a
  // role="switch" button — browsers don't propagate it as the button's accessible
  // name. Wire the NAME via aria-labelledby (the label only, so AT announces the
  // control by its label) and the supplementary copy via aria-describedby.
  const labelId = useId();
  const descId = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <span id={labelId} className="block text-sm font-medium text-fg">
          {label}
        </span>
        {description && (
          <p id={descId} className="text-xs text-muted">
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-100 [transition-timing-function:var(--ease-out)] disabled:opacity-50",
          checked ? "bg-accent" : "bg-border-strong",
        )}
      >
        <span
          className={cn(
            "inline-block size-4 rounded-full bg-accent-fg shadow-[var(--shadow-xs)] transition-transform duration-100 [transition-timing-function:var(--ease-out)]",
            checked ? "translate-x-5" : "translate-x-1",
          )}
        />
      </button>
    </div>
  );
}
