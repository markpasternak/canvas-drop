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

export const rowMenuItemClass =
  "flex h-8 w-full items-center justify-start rounded-md px-2 text-left text-xs font-medium " +
  "text-muted transition-colors duration-100 [transition-timing-function:var(--ease-out)] " +
  "hover:bg-surface-hover hover:text-fg";
