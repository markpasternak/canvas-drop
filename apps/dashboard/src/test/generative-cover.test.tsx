import { describe, expect, it } from "vitest";
import { COVER_HUE_ANCHORS, coverStyle } from "../components/GenerativeCover.js";

/** Pull every `oklch(... <hue>)` hue out of a style's colour + gradient layers. */
function huesOf(style: ReturnType<typeof coverStyle>): number[] {
  const text = `${style.backgroundColor ?? ""} ${String(style.backgroundImage ?? "")}`;
  return [...text.matchAll(/oklch\([^)]*?\s([\d.]+)\)/g)].map((m) => Number(m[1]));
}

describe("coverStyle (plan 004 / preview-parity U3)", () => {
  it("is deterministic — same seed yields the same art", () => {
    expect(coverStyle("canvas-abc")).toEqual(coverStyle("canvas-abc"));
  });

  it("differs across seeds", () => {
    expect(coverStyle("canvas-abc")).not.toEqual(coverStyle("canvas-xyz"));
  });

  it("is never blank — always a colour plus a layered gradient", () => {
    const s = coverStyle("anything");
    expect(s.backgroundColor).toBeTruthy();
    expect(String(s.backgroundImage)).toContain("radial-gradient");
  });

  it("draws hues from the curated on-brand band (not an arbitrary rainbow)", () => {
    const JITTER = 7; // matches HUE_JITTER in GenerativeCover
    // For a spread of seeds, every hue must sit within ±JITTER of a curated anchor.
    for (let i = 0; i < 200; i++) {
      for (const hue of huesOf(coverStyle(`canvas-${i}`))) {
        const nearest = Math.min(...COVER_HUE_ANCHORS.map((a) => Math.abs(a - hue)));
        expect(nearest).toBeLessThanOrEqual(JITTER);
      }
    }
  });

  it("centres the band on the teal accent (~200) with a warm amber complement (~70)", () => {
    expect(COVER_HUE_ANCHORS).toContain(200);
    expect(COVER_HUE_ANCHORS).toContain(70);
  });
});
