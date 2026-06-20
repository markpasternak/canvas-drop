import type { ReactNode } from "react";
import type { PublicationState } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { cardHoverClass, isInteractiveTarget } from "../lib/row-styles.js";
import { CanvasCover } from "./CanvasCover.js";
import { type CoverType, coverType } from "./GenerativeCover.js";
import { Tag } from "./Tag.js";

/**
 * The ONE shared full-bleed preview card, used by BOTH the owner list (Your-canvases
 * grid view) and the public gallery (UX-sweep R2). It reads as a premium gallery
 * object, not a thumbnail-plus-metadata-panel: the preview/cover fills the ENTIRE card
 * edge-to-edge (clipped by the card radius) and a single coherent overlay sits in a
 * bottom-aligned safe zone — name + status + tags + description — with the actions
 * tucked into a quiet top-right cluster. The whole card is one click target.
 *
 * Owner vs gallery is parameterised by the slots, not a fork: gallery cards pass a
 * template ("Use template") action + an owner avatar/name footer; owner cards pass
 * lifecycle actions + a bulk-select checkbox. Everything else is identical — one
 * component.
 *
 * PROTECTED READABILITY (works on ANY preview — bright, dark, busy, low-contrast —
 * in BOTH themes, with NO per-image pixel analysis):
 *   1. A persistent bottom scrim/gradient darkens the lower half of the cover so light
 *      text always has a floor to sit on.
 *   2. The bottom content + the top-right actions ride on LOCAL translucent surfaces
 *      (a frosted dark panel / frosted pills) so even a mostly-white or high-frequency
 *      busy preview can't wash the text out — the surface, not luck, guarantees it.
 * The cover renders in pure-background mode (no baked-in text) so the title is never
 * printed twice — the card overlay is the sole owner of all text.
 *
 * Light vs dark is NOT a naive invert: the overlay surfaces sit on an arbitrary image,
 * so they stay a dark frosted glass with light text in both themes (that's what reads
 * on a photo); the CARD FRAME (border, shadow, selected ring) is themed from tokens so
 * the object feels soft + warm in light and rich + clean in dark.
 *
 * Accessibility: the cover stays `aria-hidden` (decorative); the caller's `nameLink`
 * (a real router <Link> or external <a>) is the single accessible affordance, given
 * {@link cardNameLinkClass} so it reads white-on-surface. The whole-card click is a
 * convenience layer — interactive controls inside (overflow menu, action buttons,
 * tag chips) stop propagation so they never trigger the card navigation. The actions
 * are NOT the a11y-primary control: the name link is first in the bottom safe zone and
 * is the labelled affordance; the actions are a subordinate top-right cluster.
 */

const MAX_CARD_TAGS = 3;

/** A local translucent surface for an overlay cluster (the top-right actions, the
 *  bulk-select pill). A frosted dark glass + hairline so the controls read on ANY
 *  cover — bright, dark, busy — without per-image analysis. The same surface language
 *  the bottom safe-zone panel uses, scaled down for a control row. */
const overlaySurfaceClass =
  "rounded-md border border-[var(--card-overlay-border)] bg-[var(--card-overlay-fill)] p-0.5 shadow-[var(--shadow-sm)] backdrop-blur-md backdrop-saturate-150";

/** Re-export so a single import covers building the `coverType` prop. */
export { coverType };

/** The scrim-legible class for the caller's name link (white text + shadow + a
 *  stretched ::after that makes the title the implicit hit area for the whole card). */
export const cardNameLinkClass =
  "min-w-0 truncate font-display text-[0.95rem] text-white underline-offset-2 " +
  "outline-none after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:underline " +
  "[text-shadow:0_1px_3px_oklch(0_0_0_/_0.6)]";

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
        "group relative flex aspect-[3/2] cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-surface-sunken shadow-[var(--shadow-panel)]",
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
      {/* Cover fills the entire card edge-to-edge, in PURE-background mode (no baked-in
          title/type/status — the card overlay owns all text). aria-hidden, decorative. */}
      <div className="absolute inset-0">
        <CanvasCover seed={seed} previewUrl={previewUrl} type={type} status={status} plain />
      </div>

      {/* Persistent bottom scrim — a soft bottom-up darken so light overlay text/controls
          have a contrast floor even before their local surfaces. Reads on any preview
          (bright, dark, busy, low-contrast) without per-image analysis. */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          backgroundImage:
            "linear-gradient(to top, oklch(0.14 0.02 265 / 0.56) 0%, oklch(0.14 0.02 265 / 0.24) 34%, oklch(0.14 0.02 265 / 0.04) 58%, transparent 80%)",
        }}
      />

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

      {/* Bottom safe zone: one coherent frosted surface carrying name + badges, tags,
          description and footer. The local surface (not luck) guarantees legibility on
          any preview; the scrim above blends it into the cover. */}
      <div className="relative z-10 mt-auto p-2.5">
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--card-overlay-border)] bg-[var(--card-overlay-fill)] p-2.5 shadow-[var(--shadow-sm)] backdrop-blur-md backdrop-saturate-150">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {nameLink}
            {badges && (
              <span className="relative z-10 flex shrink-0 flex-wrap items-center gap-1">
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
              className="line-clamp-2 text-xs text-white/85 [text-shadow:0_1px_2px_oklch(0_0_0_/_0.55)]"
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
