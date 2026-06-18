import type { CSSProperties } from "react";
import { cn } from "../lib/cn.js";

/**
 * A deterministic generative cover (plan 004). The same `seed` always produces the
 * same art, so a canvas keeps a stable visual identity across renders and sessions.
 * It is a never-blank *identity* layer — NOT a preview of the canvas content; the
 * later real-screenshot upgrade (origin R13) renders into the SAME fixed
 * aspect-ratio region, so swapping it in needs no layout change.
 *
 * Pure CSS (a layered OKLCH mesh gradient) — no runtime dependency, no canvas/WebGL.
 * Decorative: callers mark the region aria-hidden, so it adds no screen-reader noise.
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

export function GenerativeCover({ seed, className }: { seed: string; className?: string }) {
  return <div aria-hidden className={cn("size-full", className)} style={coverStyle(seed)} />;
}
