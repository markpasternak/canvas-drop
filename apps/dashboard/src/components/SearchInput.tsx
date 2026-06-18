import { MagnifyingGlass } from "@phosphor-icons/react";
import { cn } from "../lib/cn.js";
import { searchInput } from "../lib/input-styles.js";

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the input (required — there's no visible label). */
  "aria-label": string;
  placeholder?: string;
  /** Extra classes on the wrapper (e.g. the call site's `min-w`/`flex-1` sizing). */
  className?: string;
  disabled?: boolean;
}

/**
 * The single list/filter search box (5 hand-rolled copies before consolidation): a
 * `type="search"` input on the shared {@link searchInput} recipe with a leading,
 * decorative magnifier icon. Markup mirrors the call sites exactly so migration is
 * visually neutral; `onChange` hands back the raw string (call sites debounce it).
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
  disabled,
  "aria-label": ariaLabel,
}: SearchInputProps) {
  return (
    <div className={cn("relative min-w-[14rem] flex-1", className)}>
      <MagnifyingGlass
        size={16}
        className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 text-subtle"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        className={searchInput}
      />
    </div>
  );
}
