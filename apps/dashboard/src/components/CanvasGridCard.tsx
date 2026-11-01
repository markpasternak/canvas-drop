import type { ReactNode } from "react";
import type { PublicationState } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { cardHoverClass, isInteractiveTarget } from "../lib/row-styles.js";
import { CanvasCover } from "./CanvasCover.js";
import { type CoverType, coverType } from "./GenerativeCover.js";
import { Tag } from "./Tag.js";

/** Shared artifact card. The preview carries the color; a quiet themed caption
 * carries identity and status. Interactive controls stay above the stretched link. */

const MAX_CARD_TAGS = 3;

/** A local translucent surface for an overlay cluster (the top-right actions, the
 *  bulk-select pill). A frosted dark glass + hairline so the controls read on ANY
 *  cover — bright, dark, busy — without per-image analysis. */
const overlaySurfaceClass =
  "rounded-md border border-[var(--card-overlay-border)] bg-[var(--card-overlay-fill)] p-0.5 shadow-[var(--shadow-sm)] backdrop-blur-md backdrop-saturate-150";

/** Re-export so a single import covers building the `coverType` prop. */
export { coverType };

/** The themed name link stretches its hit area across the caption. */
export const cardNameLinkClass =
  "min-w-0 max-w-full truncate font-display text-[1.05rem] text-fg underline-offset-2 " +
  "outline-none after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:underline " +
  "";

export interface CanvasGridCardProps {
  /** Stable seed for the generative fallback cover (the canvas id). */
  seed: string;
  /** Real screenshot preview URL, or undefined to always show the generative cover. */
  previewUrl?: string;
  /** Cover content axis — drives the fallback marker (template/listed/protected). */
  coverType?: CoverType;
  /** Publication lifecycle (drives the cover content axis). */
  status?: PublicationState;
  /** Display title. The cover renders pure-background (no baked text), so the title is
   *  owned by `nameLink` in the overlay; this is kept for call-site clarity + as the
   *  source the caller's `nameLink`/aria-label is built from (never printed twice). */
  title: string;
  /** The single accessible affordance: a router <Link> or external <a> the caller
   *  renders (style it with {@link cardNameLinkClass}). */
  nameLink: ReactNode;
  /** Whole-card navigation (mirrors the name link target). */
  onActivate: () => void;
  /** Optional status / access badges shown by the title. */
  badges?: ReactNode;
  /** Tag strings — capped to the first {@link MAX_CARD_TAGS}, then a "+N" chip. */
  tags?: string[];
  /** When given, tags render as clickable filter pills (gallery) instead of display
   *  chips (owner). The handler receives the clicked tag. */
  onTagClick?: (tag: string) => void;
  /** One-to-two-line description; truncates with a tooltip (title attr) on overflow. */
  description?: string | null;
  /** Top-left overlay (owner: bulk-select checkbox). Raised above the card click. */
  topLeft?: ReactNode;
  /** Top-right overlay: the overflow menu + primary action(s). Raised + stop-prop. */
  actions?: ReactNode;
  /** Bottom strip extra (gallery: owner avatar/name). Raised above the card click. */
  footer?: ReactNode;
  /** Selected (owner bulk-select) ring treatment. */
  selected?: boolean;
}

/** A control region inside the card: raised above the card's click layer and stops
 *  propagation so a click on it never triggers the whole-card navigation. */
function CardControls({ className, children }: { className?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a transparent click-shield over interactive children; the children carry their own roles/handlers.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard reaches the inner controls directly; this only shields the pointer from the card-nav layer.
    <div
      className={cn("relative z-10 flex items-center gap-1", className)}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function CanvasGridCard({
  seed,
  previewUrl,
  coverType: type,
  status,
  nameLink,
  onActivate,
  badges,
  tags = [],
  onTagClick,
  description,
  topLeft,
  actions,
  footer,
  selected = false,
}: CanvasGridCardProps) {
  const shownTags = tags.slice(0, MAX_CARD_TAGS);
  const extraTags = tags.length - shownTags.length;
  const desc = description?.trim() || undefined;

  return (
    <li
      data-canvas-item
      className={cn(
        "group relative flex w-full max-w-full cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-panel)]",
        cardHoverClass,
        selected && "border-accent ring-1 ring-accent",
      )}
      onClick={(event) => {
        if (isInteractiveTarget(event.target)) return;
        onActivate();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (isInteractiveTarget(event.target)) return;
        event.preventDefault();
        onActivate();
      }}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-surface-sunken">
        <div className="absolute inset-0">
          <CanvasCover seed={seed} previewUrl={previewUrl} type={type} status={status} plain />
        </div>

        {/* Top row: optional left control (bulk-select) + the actions/overflow, each on a
          local frosted pill so they read on any cover. The actions stay tappable (z-10)
          and stop propagation so they never navigate. On hover/focus they fade fully in;
          on touch (no hover) they stay visible. They are subordinate to the name link. */}
        <div className="relative z-10 flex items-start justify-between gap-2 p-2.5">
          {topLeft ? (
            <CardControls className={overlaySurfaceClass}>{topLeft}</CardControls>
          ) : (
            <span />
          )}
          {actions ? (
            <CardControls
              className={cn(
                overlaySurfaceClass,
                "opacity-100 transition-opacity duration-100 [transition-timing-function:var(--ease-out)] sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
              )}
            >
              {actions}
            </CardControls>
          ) : null}
        </div>
      </div>

      {/* An opaque themed caption keeps identity legible regardless of the preview. */}
      <div className="relative mt-auto p-3.5">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-col items-start gap-2">
            {nameLink}
            {badges && (
              <span className="relative z-10 flex max-w-full shrink-0 flex-wrap items-center gap-1">
                {badges}
              </span>
            )}
          </div>

          {shownTags.length > 0 && (
            <CardControls className="flex-wrap gap-1">
              {shownTags.map((tag) => (
                <Tag key={tag} size="xs" onClick={onTagClick ? () => onTagClick(tag) : undefined}>
                  {tag}
                </Tag>
              ))}
              {extraTags > 0 && (
                <Tag size="xs" tone="subtle" title={`${extraTags} more tags`}>
                  +{extraTags}
                </Tag>
              )}
            </CardControls>
          )}

          {desc && (
            // Truncated to ~2 lines with an ellipsis; the full text is exposed via the
            // native title tooltip so an overflowing description is still readable.
            <p
              className={cn("text-sm text-muted", footer ? "line-clamp-1" : "line-clamp-2")}
              title={desc}
            >
              {desc}
            </p>
          )}

          {footer && <CardControls className="pt-0.5">{footer}</CardControls>}
        </div>
      </div>
    </li>
  );
}
