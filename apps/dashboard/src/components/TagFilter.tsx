import { Check, MagnifyingGlass, Tag as TagIcon, X } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn.js";
import { useExitTransition } from "../lib/use-exit-transition.js";
import { useMediaQuery } from "../lib/use-media-query.js";
import { Tag } from "./Tag.js";

export interface TagFilterProps {
  /** Every tag selectable in scope (already deduped/sorted by the caller). */
  availableTags: readonly string[];
  /** The currently-active tag selection. Controlled by the caller (URL `?tag=`). */
  selected: readonly string[];
  /** Emits the next full selection. The caller maps this to its own URL state. */
  onChange: (next: string[]) => void;
  /** Accessible label for the control (defaults to "Filter by tag"). */
  label?: string;
  className?: string;
}

/**
 * Compact, space-optimal multi-select for canvas tags — the shared control behind
 * the owner list (U9) and gallery (U17). It owns no router state: the caller passes
 * `availableTags` + `selected` and maps `onChange` to its own `?tag=` (multi) URL.
 *
 * Defined interaction states (resolved here so the consumers don't re-litigate them):
 *  - **Zero tags:** when `availableTags` is empty the whole control renders nothing
 *    (a hidden trigger, not a disabled stub).
 *  - **Overflow:** the option list caps at ~240px (≈8 rows) and scrolls; no virtualization.
 *  - **Mobile (< 640px, matching the dashboard narrow breakpoint):** the panel opens as
 *    a bottom-sheet instead of a floating popover, so touch targets + width hold.
 *  - **Focus (aria combobox/listbox):** opening focuses the search field; `Esc` closes
 *    and restores focus to the trigger; arrows move through the checkable options;
 *    removing the last active chip returns focus to the trigger.
 */
export function TagFilter({
  availableTags,
  selected,
  onChange,
  label = "Filter by tag",
  className,
}: TagFilterProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  // Wide = floating popover; narrow = bottom-sheet. The test env stubs matchMedia to
  // `matches: false`, so the bottom-sheet (narrow) branch is what renders under test.
  const isWide = useMediaQuery("(min-width: 640px)");
  const { mounted, state } = useExitTransition(open);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);

  const listboxId = useId();
  const searchId = useId();

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? availableTags.filter((t) => t.toLowerCase().includes(q)) : availableTags;
    return [...list];
  }, [availableTags, query]);

  // Keep the roving active index inside the filtered list as it shrinks/grows.
  useEffect(() => {
    setActiveIndex((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered.length]);

  // On open: reset the search + roving index.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
  }, [open]);

  // Focus the search field once the panel is actually in the DOM. `mounted` flips
  // true one commit AFTER `open` (useExitTransition mounts it via its own effect), so
  // keying focus on `mounted && open` ensures the input exists when we focus it.
  useEffect(() => {
    if (open && mounted) searchRef.current?.focus();
  }, [open, mounted]);

  // Keep the active option scrolled into view as the roving index moves (side effect
  // lives here, not in the state updater). scrollIntoView is absent under jsdom.
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  // Close + restore focus to the trigger.
  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function toggle(tag: string) {
    if (selectedSet.has(tag)) onChange(selected.filter((t) => t !== tag));
    else onChange([...selected, tag]);
  }

  function removeChip(tag: string, isLast: boolean) {
    onChange(selected.filter((t) => t !== tag));
    // Removing the final active chip returns focus to the trigger (per spec) so the
    // user isn't stranded on a button that's about to disappear.
    if (isLast) triggerRef.current?.focus();
  }

  // Dismiss on outside pointer-down (covers both the popover and the sheet body).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const tag = filtered[activeIndex];
      if (tag) toggle(tag);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(filtered.length - 1);
    }
  }

  // Zero tags in scope → render nothing at all (hidden trigger, not a disabled stub).
  if (availableTags.length === 0) return null;

  const activeOptionId = filtered[activeIndex] ? `${listboxId}-opt-${activeIndex}` : undefined;

  const panel = (
    <div
      ref={panelRef}
      data-state={state}
      data-variant={isWide ? "popover" : "sheet"}
      data-testid="tag-filter-panel"
      className={cn(
        "z-50 flex flex-col overflow-hidden border border-border bg-surface-raised shadow-[var(--shadow-popover)]",
        isWide
          ? // Floating popover anchored under the trigger.
            "cd-anim-pop absolute top-full left-0 mt-2 w-64 rounded-xl"
          : // Bottom-sheet: pinned to the viewport bottom, full width.
            "cd-anim-sheet fixed inset-x-0 bottom-0 max-h-[80vh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]",
      )}
    >
      <div className="flex items-center gap-2 border-border border-b p-2">
        <MagnifyingGlass aria-hidden className="ml-1 size-4 shrink-0 text-subtle" />
        <input
          ref={searchRef}
          id={searchId}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onListKeyDown}
          placeholder="Search tags…"
          autoComplete="off"
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          aria-label="Search tags"
          className="h-7 w-full bg-transparent text-fg text-sm outline-none placeholder:text-subtle"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="px-3 py-4 text-center text-muted text-sm">No matching tags</p>
      ) : (
        <ul
          id={listboxId}
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the combobox/listbox pattern requires a listbox role on the options container
          role="listbox"
          aria-label={label}
          aria-multiselectable
          // ~240px ≈ 8 rows, then scroll. No virtualization (spec).
          className="max-h-[240px] overflow-y-auto p-1"
        >
          {filtered.map((tag, i) => {
            const isSelected = selectedSet.has(tag);
            const isActive = i === activeIndex;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation is handled by the combobox (Enter on the input); the click is a pointer affordance
              // biome-ignore lint/a11y/useFocusableInteractive: the combobox input owns focus; the active option is tracked via aria-activedescendant
              <li
                key={tag}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                id={`${listboxId}-opt-${i}`}
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: combobox/listbox pattern — each result is a listbox option
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  setActiveIndex(i);
                  toggle(tag);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  isActive ? "bg-surface-hover text-fg" : "text-muted",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    isSelected ? "border-accent bg-accent text-accent-fg" : "border-border-strong",
                  )}
                >
                  {isSelected && <Check weight="bold" className="size-3" />}
                </span>
                <span className="truncate">{tag}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <div className={cn("relative inline-flex flex-wrap items-center gap-1.5", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-lg border px-3 font-medium text-sm transition-colors",
          selected.length > 0
            ? "border-accent/30 bg-accent-subtle text-accent"
            : "border-border text-muted hover:bg-surface-hover hover:text-fg",
        )}
      >
        <TagIcon aria-hidden className="size-4 shrink-0" />
        {label}
        {selected.length > 0 && (
          <span className="rounded bg-accent/15 px-1.5 text-accent text-xs tabular-nums">
            {selected.length}
          </span>
        )}
      </button>

      {/* Active selections as removable chips, reusing the canonical Tag pill. */}
      {selected.map((tag) => (
        <Tag key={tag} size="sm">
          <span className="truncate">{tag}</span>
          <button
            type="button"
            onClick={() => removeChip(tag, selected.length === 1)}
            aria-label={`Remove tag ${tag}`}
            className="ml-1 inline-flex items-center text-subtle transition-colors hover:text-fg"
          >
            <X aria-hidden className="size-3" />
          </button>
        </Tag>
      ))}

      {mounted && (
        <>
          {/* Sheet gets a dismiss scrim; the popover relies on outside-pointerdown. */}
          {!isWide && (
            <div
              aria-hidden
              data-state={state}
              onClick={() => setOpen(false)}
              className="cd-anim-scrim fixed inset-0 z-40 bg-[var(--scrim)]"
            />
          )}
          {panel}
        </>
      )}
    </div>
  );
}
