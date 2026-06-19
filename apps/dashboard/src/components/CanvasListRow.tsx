import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { rowHoverClass } from "../lib/row-styles.js";
import { CanvasCover } from "./CanvasCover.js";
import { type CoverType, coverType } from "./GenerativeCover.js";

/**
 * The ONE shared list row, used by BOTH the owner list (Your-canvases list view)
 * and the public gallery list mode (UX-sweep R2). The two are near-identical: a
 * hero thumbnail, the name link + badges, a quiet meta line, a description, tag
 * pills, an optional wide-screen stat gutter, and a trailing actions cluster. The
 * only gallery-specific differentiator is the template ("Use template") affordance,
 * which the caller passes into the `actions` slot.
 *
 * Accessibility mirrors the grid card: the cover is `aria-hidden` (decorative), the
 * caller's `nameLink` (router <Link> or external <a>) is the single labelled
 * affordance, and the whole-row click is a convenience layer that ignores clicks on
 * interactive controls.
 */

export { coverType };

/** Does the event originate from an interactive control (so the row must NOT navigate)? */
function fromControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest("a, button, input, select, textarea, summary, [role='button'], [role='menu']"),
    )
  );
}

export interface CanvasListRowProps {
  /** Stable seed for the generative fallback cover (the canvas id). */
  seed: string;
  /** Real screenshot preview URL (thumb rendition), or undefined for the fallback. */
  previewUrl?: string;
  /** Cover content axis — drives the (aria-hidden) fallback marker. */
  coverType?: CoverType;
  /** The single accessible affordance: a router <Link> or external <a>. */
  nameLink: ReactNode;
  /** Whole-row navigation (mirrors the name link target). */
  onActivate: () => void;
  /** Status / access / template badges shown by the title. */
  badges?: ReactNode;
  /** A quiet identity/meta line under the title (slug, visibility, edited-time, …). */
  meta?: ReactNode;
  /** One-line description; truncated with a tooltip (title attr) on overflow. */
  description?: string | null;
  /** Tag pills row. */
  tags?: ReactNode;
  /** Wide-screen (lg) right-aligned stat gutter (owner: Published/Views/Created). */
  stats?: ReactNode;
  /** Leading bulk-select checkbox (owner only). */
  leading?: ReactNode;
  /** Trailing actions cluster (owner: Details/Open/menu; gallery: Use-template/menu). */
  actions?: ReactNode;
  /** Selected (owner bulk-select) tint. */
  selected?: boolean;
}

export function CanvasListRow({
  seed,
  previewUrl,
  coverType: type,
  nameLink,
  onActivate,
  badges,
  meta,
  description,
  tags,
  stats,
  leading,
  actions,
  selected = false,
}: CanvasListRowProps) {
  const desc = description?.trim() || undefined;
  return (
    // The <li> stays non-interactive (no role/tabIndex) per biome's a11y rules; the
    // name link is the keyboard affordance. The whole-row pointer-click (and
    // Enter/Space when focus is on the row, not a control) navigates.
    <li
      data-canvas-item
      className={cn(
        "cursor-pointer rounded-xl border border-border bg-surface px-4 py-4 shadow-[var(--shadow-panel)] lg:rounded-none lg:border-0 lg:bg-transparent lg:shadow-none lg:hover:bg-surface-raised",
        rowHoverClass,
        selected && "bg-accent-subtle lg:bg-accent-subtle",
      )}
      onClick={(event) => {
        if (fromControl(event.target)) return;
        onActivate();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (fromControl(event.target)) return;
        event.preventDefault();
        onActivate();
      }}
    >
      <div className="flex items-center gap-3 sm:gap-4">
        {leading}
        {/* Hero thumbnail (decorative; the name is the affordance). The row thumb is
            too small to legibly overlay a title, so it stays the plain seeded mesh —
            pure background, no baked-in text — the row's own columns carry the labels. */}
        <div className="aspect-[3/2] w-24 shrink-0 overflow-hidden rounded-md border border-border/60 sm:w-28">
          <CanvasCover seed={seed} previewUrl={previewUrl} type={type} plain />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {nameLink}
            {badges && <span className="flex shrink-0 flex-wrap items-center gap-1">{badges}</span>}
          </div>
          {meta && <div className="mt-0.5 truncate text-xs text-subtle">{meta}</div>}
          {desc && (
            <div className="mt-1 truncate text-xs text-muted" title={desc}>
              {desc}
            </div>
          )}
          {tags && <div className="mt-1.5">{tags}</div>}
        </div>

        {stats && <div className="hidden shrink-0 items-center gap-8 lg:flex">{stats}</div>}

        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
    </li>
  );
}
