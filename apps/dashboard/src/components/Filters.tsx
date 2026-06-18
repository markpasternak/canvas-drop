import type { ReactNode, SelectHTMLAttributes } from "react";
import { useId } from "react";
import { cn } from "../lib/cn.js";

/** Shared list-filter primitives (plan 004), reused by the gallery and the
 *  Your-canvases list so both surfaces filter with one visual vocabulary. */

/** A flex wrapper for a row of filter controls. Wraps on narrow viewports. */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterSelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> {
  /** Accessible label (visually hidden) describing what the select controls. */
  label: string;
  options: FilterOption[];
  value: string;
  onValueChange: (value: string) => void;
}

/** A compact native select for single-choice filters (owner, sort). Native so it
 *  stays keyboard- and screen-reader-accessible with no extra machinery. */
export function FilterSelect({
  label,
  options,
  value,
  onValueChange,
  className,
  ...rest
}: FilterSelectProps) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className={cn(
          "h-9 rounded-lg border border-border bg-surface pr-8 pl-3 text-sm text-fg",
          "transition-colors focus:border-border-strong focus:outline-none",
          className,
        )}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </>
  );
}

export interface FilterChipProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  /** Optional concept-colour dot (a `bg-*` utility) shown leading the label, so the
   *  chip carries the same colour as its matching stat + row badge. Decorative —
   *  the chip's text label is always the primary signal. */
  dotClassName?: string;
  /** Accessible label when the chip's text alone isn't descriptive. */
  "aria-label"?: string;
}

/** A toggle chip for boolean filters (templatable; the access/deployment states on
 *  Your canvases). Mirrors the admin status-tab styling — accent when active. A
 *  leading concept dot (when given) keeps the chip colour-consistent with the
 *  stat strip and the row badges. */
export function FilterChip({ active, onClick, children, dotClassName, ...rest }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors",
        active
          ? "border-accent/30 bg-accent-subtle text-accent"
          : "border-border text-muted hover:bg-surface-hover hover:text-fg",
      )}
      {...rest}
    >
      {dotClassName && (
        <span className={cn("size-1.5 shrink-0 rounded-full", dotClassName)} aria-hidden />
      )}
      {children}
    </button>
  );
}
