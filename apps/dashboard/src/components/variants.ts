/**
 * Shared control vocabulary — the single source of truth for the variant / tone /
 * size unions the primitives speak. Components import these so the vocabulary can't
 * drift between Button, IconButton, Badge, InlineNotice and the menus.
 *
 * Two axes, deliberately separate:
 *   - `Variant` — emphasis of an interactive control (Button): primary > secondary >
 *     ghost, plus a `danger` for destructive intent.
 *   - `Tone` — semantic color of a status/affordance surface (Badge, InlineNotice):
 *     the neutral baseline plus the accent + status colors.
 *
 * Size is one scale (`sm`/`md`/`lg`) mapped to the `--control-*` height tokens so a
 * control's height always traces back to a token, never a hand-typed `h-*`.
 */

/** Emphasis of an interactive control. Matches Button's set. */
export type Variant = "primary" | "secondary" | "ghost" | "danger";

/** Semantic color of a status/affordance surface. Matches Badge / InlineNotice. */
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/** Control size scale. */
export type Size = "sm" | "md" | "lg";

/**
 * Size → control-height utility, keyed to the `--control-*` tokens in tokens.css
 * (`--control-sm: 2rem` = h-8, `--control-md: 2.25rem` = h-9, `--control-lg: 2.5rem`
 * = h-10). Use for square/height-driven controls so heights stay token-backed.
 */
export const controlHeight: Record<Size, string> = {
  sm: "h-[var(--control-sm)]",
  md: "h-[var(--control-md)]",
  lg: "h-[var(--control-lg)]",
};
