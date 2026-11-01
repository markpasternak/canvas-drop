/**
 * The one shared input recipe. Extracted here so the control's look (border, focus
 * ring, transition, disabled) lives in a single place instead of being copy-pasted
 * across `Field`, `SlugField`, and `PasswordField`.
 *
 * `inputControlBase` is everything EXCEPT horizontal padding, so a field that needs
 * custom padding (e.g. `PasswordField`'s room for trailing adornments) can compose
 * the same appearance without a `px-*`/`pl-*` collision (our `cn` is a plain join,
 * not tailwind-merge). `inputControl` is the standard control (base + `px-3`) used
 * by `Field`/`SlugField`.
 */

/** Shared input appearance minus horizontal padding (compose with a `px-*`/`pl-*`). */
export const inputControlBase =
  "w-full rounded-md border border-border-strong bg-surface-raised py-2 text-sm text-fg " +
  "placeholder:text-subtle transition-colors duration-100 [transition-timing-function:var(--ease-out)] " +
  "focus:border-accent focus:outline-none focus-visible:outline-none " +
  "focus:ring-2 focus:ring-accent/30 disabled:opacity-50";

/** Standard text-input control: the shared appearance with symmetric `px-3` padding. */
export const inputControl = `${inputControlBase} px-3`;

/** Shared single-choice trigger appearance. Native forms and custom filter menus
 * use the same surface, focus treatment and spacing; only their popup behavior differs. */
export const selectControl =
  "cd-touch-target min-w-0 rounded-md border border-border-strong bg-surface-raised text-fg " +
  "transition-colors duration-100 [transition-timing-function:var(--ease-out)] " +
  "hover:border-accent/60 focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-accent " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const selectSizes = {
  sm: "h-8 text-xs",
  md: "h-9 text-sm",
  lg: "h-10 text-sm",
} as const;

/**
 * The list/filter search-box recipe (5 byte-identical copies before consolidation):
 * a 36px pill with left padding for the leading magnifier icon. Kept verbatim so the
 * `SearchInput` migration is visually neutral across the 5 call sites.
 */
export const searchInput =
  "h-9 w-full rounded-lg border border-border bg-surface pr-3 pl-9 text-sm text-fg " +
  "placeholder:text-subtle focus:border-border-strong focus:outline-none";
