import { describe, expect, it } from "vitest";
import { AA_TEXT, contrastRatio } from "./contrast.js";
import { SKIN_NAMES, SKINS } from "./skins.js";
import { BRAND_TOKENS, type ThemeName } from "./tokens.js";

/**
 * WCAG AA guard for the brand ramp + every skin (DESIGN.md: "All pairings target
 * WCAG 2.1 AA"). OKLCH is perceptually even but not contrast-safe by construction, so
 * each accent pairing a skin introduces is checked against AA here — a new or retuned
 * skin that fails is caught in CI, not by a user. The base ramp (editorial) is the
 * proven palette; studio/workshop/canvas must clear the same bar in BOTH themes.
 *
 * Pairings checked (all real usages):
 *  - accent fill ↔ accent-fg  → primary button label (body text → 4.5:1)
 *  - accent text ↔ accent-subtle → badge / selected-state text (4.5:1)
 *  - accent text ↔ surface → links / active nav on a panel (4.5:1)
 */
const THEMES: ThemeName[] = ["light", "dark"];

describe("contrastRatio known answers (anchors the OKLCH→luminance formula)", () => {
  // The skin pairings below only assert "≥ AA". A luminance bug that shifted every value but
  // preserved relative ordering would still clear AA and slip through — so pin the formula to
  // WCAG's defined endpoints, which only a correct OKLCH→linear→luminance pipeline produces.
  it("white vs black is the 21:1 maximum", () => {
    expect(contrastRatio("oklch(1 0 0)", "oklch(0 0 0)")).toBeCloseTo(21, 5);
  });
  it("a colour against itself is 1:1", () => {
    expect(contrastRatio("oklch(0.7 0.12 150)", "oklch(0.7 0.12 150)")).toBeCloseTo(1, 5);
  });
  it("is symmetric in its arguments", () => {
    const [x, y] = ["oklch(0.6 0.1 250)", "oklch(0.95 0.02 90)"];
    expect(contrastRatio(x, y)).toBeCloseTo(contrastRatio(y, x), 10);
  });
});

describe("skin accent contrast (WCAG AA)", () => {
  for (const skin of SKIN_NAMES) {
    for (const theme of THEMES) {
      const a = SKINS[skin][theme];
      const surface = BRAND_TOKENS[theme].surface;

      it(`${skin} · ${theme} · button label (accent ↔ accent-fg) clears AA`, () => {
        expect(contrastRatio(a.accent, a["accent-fg"])).toBeGreaterThanOrEqual(AA_TEXT);
      });

      it(`${skin} · ${theme} · badge text (accent ↔ accent-subtle) clears AA`, () => {
        expect(contrastRatio(a.accent, a["accent-subtle"])).toBeGreaterThanOrEqual(AA_TEXT);
      });

      it(`${skin} · ${theme} · link on surface (accent ↔ surface) clears AA`, () => {
        expect(contrastRatio(a.accent, surface)).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }
});
