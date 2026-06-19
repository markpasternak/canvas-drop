/**
 * Shared class strings for canvas-row actions, so callers that render into a
 * `CanvasRow`'s `actions` slot (e.g. the Your-canvases route's Active/Archived
 * rows) can match the row's primary-action and overflow-menu styling without
 * importing presentation internals from the component module itself.
 */

export const rowPrimaryActionClass =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-surface-raised px-3 " +
  "text-[0.8125rem] font-medium text-fg border border-border-strong transition-all duration-100 " +
  "[transition-timing-function:var(--ease-out)] hover:bg-surface-hover active:translate-y-px";

/**
 * One hover model for "a canvas", shared so the gallery card, the grid card, and
 * the list row never diverge into ad-hoc treatments:
 *
 *   - {@link cardHoverClass} — CARDS (gallery + grid `CanvasCard`) LIFT: a small
 *     upward translate + raised border. The cover-forward card reads as a tile you
 *     can pick up.
 *   - {@link rowHoverClass} — LIST ROWS TINT + BORDER: no lift (rows sit in a dense
 *     divided list where a translate would feel jumpy); the surface tints and the
 *     border strengthens on hover instead.
 *
 * Both are transform/opacity/color only and collapse under reduced-motion via the
 * global block. Callers append their own layout/selected classes.
 */
export const cardHoverClass =
  "transition-[transform,border-color,box-shadow] duration-100 [transition-timing-function:var(--ease-out)] " +
  "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[var(--shadow-popover)]";

export const rowHoverClass =
  "transition-colors duration-100 [transition-timing-function:var(--ease-out)] " +
  "hover:border-border-strong hover:bg-surface-raised";

/**
 * Does a click/keydown event originate from an interactive control inside a
 * whole-card / whole-row click target — so the card/row must NOT also navigate?
 *
 * Shared by {@link CanvasGridCard} and {@link CanvasListRow} (they had diverging
 * local copies — one included `summary`, the other didn't). This is the SUPERSET
 * selector: a `<summary>` (a `<details>` disclosure) is interactive and must shield
 * the card click in both surfaces.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest("a, button, input, select, textarea, summary, [role='button'], [role='menu']"),
    )
  );
}
