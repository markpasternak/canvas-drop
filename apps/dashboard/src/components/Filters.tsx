import { CaretDown, Check } from "@phosphor-icons/react";
import type { ButtonHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
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
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value"> {
  /** Accessible label (visually hidden) describing what the select controls. */
  label: string;
  options: FilterOption[];
  value: string;
  onValueChange: (value: string) => void;
}

/** A compact single-choice filter menu. We do not use a native <select> here because
 *  desktop browsers hand the open popup to the OS, which can render oversized,
 *  theme-mismatched menus that ignore the app's density. */
export function FilterSelect({
  label,
  options,
  value,
  onValueChange,
  className,
  disabled,
  ...rest
}: FilterSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options[selectedIndex] ?? options[0];

  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function choose(next: string) {
    if (next !== value) onValueChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function move(delta: number) {
    if (options.length === 0) return;
    setActiveIndex((current) => (current + delta + options.length) % options.length);
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) setOpen(true);
        else move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) setOpen(true);
        else move(-1);
        break;
      case "Home":
        if (!open) return;
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        if (!open) return;
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (!open) setOpen(true);
        else choose(options[activeIndex]?.value ?? value);
        break;
      case "Escape":
        if (!open) return;
        event.preventDefault();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
        disabled={disabled}
        value={value}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "inline-flex h-9 min-w-36 items-center justify-between gap-3 rounded-lg border border-border bg-surface pr-2 pl-3 text-sm text-fg",
          "transition-colors hover:bg-surface-hover focus:border-border-strong focus:outline-none",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
        {...rest}
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <CaretDown
          size={14}
          weight="bold"
          className={cn("shrink-0 text-subtle transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-labelledby={labelId}
          className="absolute top-full right-0 z-50 mt-1 max-h-72 min-w-full overflow-auto rounded-lg border border-border bg-surface-raised p-1 text-sm shadow-[var(--shadow-popover)]"
        >
          {options.map((o, index) => {
            const active = index === activeIndex;
            const selectedOption = o.value === value;
            return (
              <button
                key={o.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={selectedOption}
                tabIndex={-1}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(o.value)}
                className={cn(
                  "flex h-8 w-full min-w-40 items-center gap-2 rounded-md px-2 text-left font-medium whitespace-nowrap transition-colors",
                  active ? "bg-surface-hover text-fg" : "text-muted",
                  selectedOption && "text-accent",
                )}
              >
                <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
                  {selectedOption && <Check size={14} weight="bold" />}
                </span>
                <span className="truncate">{o.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
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
