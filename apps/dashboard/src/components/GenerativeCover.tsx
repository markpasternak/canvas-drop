import type { CSSProperties } from "react";
import type { PublicationState } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { type Concept, conceptColor, conceptIcon } from "./concept-colors.js";

/**
 * A deterministic generative cover (plan 004; content-aware in UX-sweep U6). The same
 * `seed` always produces the same mesh art, so a canvas keeps a stable visual identity
 * across renders and sessions. It is a never-blank *identity* layer — NOT a preview of
 * the canvas content; the access-gated real-screenshot path through {@link CanvasCover}
 * renders into the SAME fixed aspect-ratio region, so swapping it in needs no layout
 * change.
 *
 * Content-aware (U6): on the seeded mesh background we can overlay the canvas **title**
 * (clamped to 2 lines) plus a small **type/status marker** so a wall of fallbacks aids
 * recognition instead of reading as undifferentiated noise. The whole region stays
 * `aria-hidden` — the surrounding card/list carries the real, labelled title affordance,
 * so we never duplicate the title into the a11y tree.
 *
 * Pure-background mode (UX-sweep, `plain`): the full-bleed grid card owns its own
 * overlay (name + status + tags + description on a protected scrim), so it renders the
 * cover as a PURE seeded mesh — no baked-in title/type/status — to avoid printing the
 * title twice. The content-aware overlay stays the default and is used by the
 * detail/settings preview (a standalone cover with no surrounding card chrome).
 *
 * Pure CSS (a layered OKLCH mesh gradient) — no runtime dependency, no canvas/WebGL.
 *
 * On-brand palette (preview-parity U3): the covers stay genuinely colourful and
 * per-canvas distinct, but their hues are drawn from a *curated, brand-anchored*
 * band rather than a random 0–360 rainbow. The band centres on the deep-teal
 * accent (hue ~200, see tokens.css `--accent`) with a warm amber complement (~70)
 * and a few harmonious neighbours, so the gallery reads vivid AND cohesive.
 */

/**
 * Curated on-brand hue anchors. Centred on the teal accent (~200) with a warm
 * amber complement (~70) and harmonious neighbours either side, so a wall of
 * covers feels designed rather than rainbow. Hues are picked from this set by the
 * seed hash, keeping each canvas distinct + deterministic. Exported so tests can
 * assert covers stay within the curated band.
 */
export const COVER_HUE_ANCHORS = [
  200, // teal — the brand accent
  185, // teal-cyan neighbour
  220, // teal-blue neighbour
  165, // green-teal neighbour
  70, // warm amber complement
  45, // amber-orange neighbour
  95, // amber-chartreuse neighbour
  250, // cool indigo (sparse cool extreme, still harmonious)
] as const;

/** FNV-1a → a stable unsigned 32-bit seed from the canvas id. */
function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Pick one of the curated anchors by index, plus a small deterministic jitter
 * (±7°) so covers sharing an anchor still differ subtly. Result stays within the
 * curated band (anchor ± jitter), which the cover test asserts.
 */
const HUE_JITTER = 7;
function brandHue(index: number, jitterBits: number): number {
  // The modulo keeps the index in range; `?? 200` is an unreachable fallback that
  // satisfies noUncheckedIndexedAccess (the array is a non-empty const).
  const anchor = COVER_HUE_ANCHORS[index % COVER_HUE_ANCHORS.length] ?? 200;
  const jitter = (jitterBits % (HUE_JITTER * 2 + 1)) - HUE_JITTER;
  return anchor + jitter;
}

export function coverStyle(seed: string): CSSProperties {
  const h = hashSeed(seed);
  // Three related on-brand hues + two blob anchor points from disjoint bit-slices
  // of the hash, so distinct canvases look distinct but each canvas is deterministic.
  // Use unsigned (`>>>`) shifts so the slices stay non-negative — a signed `>>`
  // would wrap to a negative index and break the curated-band selection.
  const hue1 = brandHue(h % COVER_HUE_ANCHORS.length, (h >>> 2) % 100);
  const hue2 = brandHue((h >>> 8) % COVER_HUE_ANCHORS.length, (h >>> 10) % 100);
  const hue3 = brandHue((h >>> 16) % COVER_HUE_ANCHORS.length, (h >>> 18) % 100);
  const x1 = 15 + (h % 50);
  const y1 = 12 + ((h >>> 3) % 45);
  const x2 = 55 + ((h >>> 5) % 35);
  const y2 = 60 + ((h >>> 7) % 30);
  return {
    backgroundColor: `oklch(0.62 0.15 ${hue1})`,
    backgroundImage: [
      `radial-gradient(at ${x1}% ${y1}%, oklch(0.74 0.16 ${hue2}) 0px, transparent 55%)`,
      `radial-gradient(at ${x2}% ${y2}%, oklch(0.52 0.17 ${hue3}) 0px, transparent 50%)`,
    ].join(", "),
  };
}

/**
 * The "type" axis a cover can mark — a subset of the canvas-state {@link Concept}
 * taxonomy (template / listed / protected). `canvas` is the plain default with no
 * concept tint. This reuses the SAME concept vocabulary the row/gallery badges use
 * (see `concept-colors.ts`), so the fallback marker can never drift from the badges.
 */
export type CoverType = "canvas" | "templates" | "listed" | "protected";

const TYPE_LABEL: Record<CoverType, string> = {
  canvas: "Canvas",
  templates: "Template",
  listed: "Listed",
  protected: "Protected",
};

const STATUS_LABEL: Record<PublicationState, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
  disabled: "Disabled",
  deleted: "Deleted",
};

/** Phosphor `Stack`-style glyph for the type marker, drawn from the shared concept map. */
function typeIcon(type: CoverType) {
  return type === "canvas" ? null : conceptIcon(type as Concept);
}

/**
 * Derive the cover "type" from a canvas-like shape using the SAME priority the row
 * badges use (template > listed > protected > plain canvas). Accepts the partial
 * flags both `CanvasListItem` (gallery*) and ad-hoc callers carry, so a single
 * mapping serves every call site.
 */
export function coverType(flags: {
  templatable?: boolean;
  listed?: boolean;
  protectedByPassword?: boolean;
}): CoverType {
  if (flags.templatable) return "templates";
  if (flags.listed) return "listed";
  if (flags.protectedByPassword) return "protected";
  return "canvas";
}

export interface CoverContent {
  /** Canvas title to overlay (clamped to 2 lines). Falls back to a generic label if absent. */
  title?: string;
  /** The canvas "type" — reuses the concept taxonomy for its label + tint. */
  type?: CoverType;
  /** Derived publication lifecycle, shown as a small status marker. */
  status?: PublicationState;
  /** Pure-background mode: render ONLY the seeded mesh — no baked-in title/type/status
   *  overlay and no internal scrim. The carded contexts (the full-bleed grid card) own
   *  their own overlay, so the cover must stay text-free to avoid duplicating the title. */
  plain?: boolean;
}

/**
 * The content-aware fallback cover: the deterministic seeded mesh as a background,
 * with the title + a type/status marker overlaid for recognition. Entirely
 * `aria-hidden` (decorative — the title is the accessible affordance elsewhere).
 *
 * Layout note: the overlay uses absolute positioning inside a `relative` box and a
 * 2-line clamp, so it never changes the cover's outer aspect-ratio box (callers keep
 * their fixed `aspect-[3/2]` wrappers).
 */
export function GenerativeCover({
  seed,
  className,
  title,
  type = "canvas",
  status,
  plain = false,
}: { seed: string; className?: string } & CoverContent) {
  const TypeIcon = typeIcon(type);
  const typeTint = type === "canvas" ? undefined : conceptColor(type as Concept);
  // Pure-background mode (carded contexts): just the seeded mesh, no baked-in text.
  if (plain) {
    return (
      <div
        aria-hidden
        data-cover-plain
        className={cn("size-full overflow-hidden", className)}
        style={coverStyle(seed)}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={cn("relative size-full overflow-hidden", className)}
      style={coverStyle(seed)}
    >
      {/* Legibility scrim — a bottom-up dark gradient so the overlaid text reads on
          any seeded hue without changing the mesh itself. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(to top, oklch(0.18 0.03 240 / 0.78) 0%, oklch(0.18 0.03 240 / 0.32) 38%, transparent 72%)",
        }}
      />
      <div className="absolute inset-0 flex flex-col justify-end gap-1.5 p-3">
        {/* Title — fixed token-sized font, clamped to 2 lines with ellipsis so long
            titles never overflow the fixed cover box. */}
        <span className="line-clamp-2 font-display text-sm text-white leading-snug [text-shadow:0_1px_2px_oklch(0_0_0_/_0.5)]">
          {title?.trim() || "Untitled canvas"}
        </span>
        {/* Type/status marker — small chips drawing the type label + tint from the
            shared concept vocabulary. */}
        <span className="flex flex-wrap items-center gap-1">
          <span
            data-cover-type={type}
            className={cn(
              "inline-flex items-center gap-1 rounded border border-white/20 px-1.5 py-0.5 font-medium text-[0.625rem] leading-none",
              typeTint ? cn(typeTint.bg, typeTint.text) : "bg-white/15 text-white",
            )}
          >
            {TypeIcon && <TypeIcon size={10} weight="bold" aria-hidden />}
            {TYPE_LABEL[type]}
          </span>
          {status && (
            <span
              data-cover-status={status}
              className="inline-flex items-center rounded border border-white/20 bg-black/25 px-1.5 py-0.5 font-medium text-[0.625rem] text-white leading-none"
            >
              {STATUS_LABEL[status]}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
