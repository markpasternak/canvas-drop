import { X } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { cn } from "../lib/cn.js";
import { inputControl } from "../lib/input-styles.js";
import { Tag } from "./Tag.js";

/** Limits mirror the server `update_canvas` zod schema: `z.array(z.string().max(50)).max(20)`. */
export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 50;

/** Trim + lowercase on confirm so tags match the search normalization and dedupe with
 *  the gallery/owner-list TagFilter vocabulary. */
function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Unified tags editor — a first-class canvas property used by both the owner-list and
 * the public gallery filter, not a gallery-only field. A text input where **Enter or
 * comma confirms** a tag; each confirmed tag renders as the shared {@link Tag} pill with
 * a `×` to remove it. Values are trimmed + lowercased on confirm; duplicates are
 * ignored; the control enforces the server limits (max {@link MAX_TAGS} tags, max
 * {@link MAX_TAG_LEN} chars each).
 *
 * Controlled: the parent owns `value` (the canonical tag array) and persists via its
 * own update mutation in `onChange`. This component never calls the API itself.
 */
export function TagsEditor({
  value,
  onChange,
  label = "Tags",
  hint,
  description,
  disabled,
  suggestions,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  label?: string;
  hint?: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  /** Optional existing-tag vocabulary offered as autocomplete (nice-to-have). */
  suggestions?: string[];
}) {
  const inputId = useId();
  const listId = useId();
  const [draft, setDraft] = useState("");
  const atMax = value.length >= MAX_TAGS;

  function commit(raw: string) {
    const tag = normalizeTag(raw);
    if (!tag) return;
    // Reject over-length and over-count consistently with the server schema.
    if (tag.length > MAX_TAG_LEN) return;
    if (value.length >= MAX_TAGS) return;
    if (value.includes(tag)) {
      setDraft("");
      return;
    }
    onChange([...value, tag]);
    setDraft("");
  }

  function remove(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  // Autocomplete: surface the owner's existing tags not already applied here.
  const datalistTags = (suggestions ?? []).filter((t) => !value.includes(t)).slice(0, 50);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label htmlFor={inputId} className="text-sm font-medium text-fg">
          {label}
        </label>
        {hint && <span className="text-xs text-subtle">{hint}</span>}
      </div>

      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Current tags">
          {value.map((tag) => (
            <li key={tag}>
              <Tag size="sm" className="gap-1 pr-1">
                <span>{tag}</span>
                <button
                  type="button"
                  onClick={() => remove(tag)}
                  disabled={disabled}
                  aria-label={`Remove tag ${tag}`}
                  className="-mr-0.5 grid size-4 place-items-center rounded-sm text-subtle transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
                >
                  <X size={11} weight="bold" aria-hidden />
                </button>
              </Tag>
            </li>
          ))}
        </ul>
      )}

      <input
        id={inputId}
        className={cn(inputControl)}
        value={draft}
        disabled={disabled || atMax}
        maxLength={MAX_TAG_LEN}
        placeholder={atMax ? `Tag limit reached (${MAX_TAGS})` : "Add a tag, then press Enter"}
        list={datalistTags.length > 0 ? listId : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          // A comma confirms the tag-in-progress (handles paste of "a,b,c" too).
          if (raw.includes(",")) {
            const parts = raw.split(",");
            const trailing = parts.pop() ?? "";
            // Commit every complete segment; keep the trailing fragment as the draft.
            for (const part of parts) commit(part);
            setDraft(trailing);
            return;
          }
          setDraft(raw);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            // Backspace on an empty input removes the last tag (common chip-input idiom).
            const last = value[value.length - 1];
            if (last !== undefined) remove(last);
          }
        }}
        onBlur={() => commit(draft)}
      />
      {datalistTags.length > 0 && (
        <datalist id={listId}>
          {datalistTags.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      )}
      {description && <p className="text-xs text-muted">{description}</p>}
    </div>
  );
}
