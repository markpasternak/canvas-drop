import type { Icon } from "@phosphor-icons/react";
import { cn } from "../lib/cn.js";
import type { Size } from "./variants.js";

/**
 * One option in a {@link SegmentedControl}. `label` is always the accessible name
 * (even when `iconOnly` hides it visually). `icon` and `count` are optional
 * adornments; `count` renders as a muted trailing number (e.g. a result tally).
 */
export interface SegmentedItem<V extends string> {
  value: V;
  label: string;
  icon?: Icon;
  count?: number;
  disabled?: boolean;
  /** Tooltip + title; defaults to `label`. */
  title?: string;
}

export interface SegmentedControlProps<V extends string> {
  items: ReadonlyArray<SegmentedItem<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Accessible name for the whole group (required — this is a `role="group"`). */
  "aria-label": string;
  /**
   * Render each option as an icon-only chip (the label becomes `aria-label`/`title`
   * only). Items without an `icon` still show their text label. Defaults to false.
   */
  iconOnly?: boolean;
  size?: Size;
  className?: string;
}

/**
 * The single segmented-control primitive: a sunken track holding mutually-exclusive
 * options, the active one lifted to a raised chip. Bakes in the a11y once — a
 * `role="group"` container with the caller's `aria-label`, and each option a real
 * `<button aria-pressed={active}>` so screen readers announce the on/off state and
 * keyboard activation (Enter/Space) is free.
 *
 * Controlled: pass `value` + `onChange`. Replaces the hand-rolled scope/view/mode
 * toggles so the active treatment can't drift across the dashboard.
 */
export function SegmentedControl<V extends string>({
  items,
  value,
  onChange,
  "aria-label": ariaLabel,
  iconOnly = false,
  size = "md",
  className,
}: SegmentedControlProps<V>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a button-group toggle (role=group + aria-label + aria-pressed buttons), not a form fieldset.
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center rounded-lg border border-border bg-surface-sunken p-0.5",
        size === "sm" ? "h-8" : size === "lg" ? "h-10" : "h-9",
        className,
      )}
    >
      {items.map((item) => {
        const ItemIcon = item.icon;
        const active = item.value === value;
        const showLabel = !iconOnly || !ItemIcon;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            aria-label={iconOnly ? item.label : undefined}
            title={item.title ?? item.label}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            className={cn(
              "inline-flex h-full items-center justify-center gap-1.5 rounded-md font-medium transition-all duration-100 [transition-timing-function:var(--ease-out)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40",
              iconOnly ? "px-2.5" : "px-3",
              size === "sm" ? "text-xs" : "text-sm",
              active
                ? "bg-surface-raised text-fg shadow-[var(--shadow-panel)]"
                : "text-muted hover:text-fg",
            )}
          >
            {ItemIcon && (
              <ItemIcon
                size={size === "sm" ? 15 : 16}
                weight={active ? "fill" : "regular"}
                aria-hidden
              />
            )}
            {showLabel && <span>{item.label}</span>}
            {item.count !== undefined && (
              <span className="text-xs tabular-nums text-subtle">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
