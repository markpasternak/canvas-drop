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
 */

/** FNV-1a → a stable unsigned 32-bit seed from the canvas id. */
function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function coverStyle(seed: string): CSSProperties {
  const h = hashSeed(seed);
  // Derive three related hues + two blob anchor points from disjoint bit-slices of
  // the hash, so distinct canvases look distinct but each canvas is deterministic.
  const hue1 = h % 360;
  const hue2 = (hue1 + 35 + ((h >> 8) % 90)) % 360;
  const hue3 = (hue1 + 150 + ((h >> 16) % 90)) % 360;
  const x1 = 15 + (h % 50);
  const y1 = 12 + ((h >> 3) % 45);
  const x2 = 55 + ((h >> 5) % 35);
  const y2 = 60 + ((h >> 7) % 30);
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
