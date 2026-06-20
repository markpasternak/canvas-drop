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
