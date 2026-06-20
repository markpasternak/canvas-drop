import { describe, expect, it } from "vitest";
import {
  ACCENT_ROLE_ORDER,
  DEFAULT_SKIN,
  isSkinName,
  SKIN_NAMES,
  SKINS,
  SYNTAX_ROLE_ORDER,
  SYNTAX_TOKENS,
  skinAccentCssVars,
  skinDisplayCssVars,
  skinOverridesCss,
  syntaxCssVars,
} from "./skins.js";
import { BRAND_TOKENS } from "./tokens.js";

// hue ~270–279 (indigo-violet), in any oklch form — the SaaS default the rebrand
// rejected. Also catches a stray 27x digit run. Mirrors the guard in tokens.test.ts.
const INDIGO = /oklch\([^)]*\b27[0-9]\b/;

/** First number after `oklch(` = the OKLCH lightness (0–1). */
function lightnessOf(oklch: string): number {
  const m = oklch.match(/oklch\(\s*([0-9.]+)/);
  if (!m) throw new Error(`not an oklch value: ${oklch}`);
  return Number(m[1]);
}

function allSkinValues(): string[] {
  const out: string[] = [];
  for (const skin of SKIN_NAMES) {
    const def = SKINS[skin];
    for (const theme of ["light", "dark"] as const) {
      for (const role of ACCENT_ROLE_ORDER) out.push(def[theme][role]);
    }
  }
  for (const theme of ["light", "dark"] as const) {
    for (const role of SYNTAX_ROLE_ORDER) out.push(SYNTAX_TOKENS[theme][role]);
  }
  return out;
}

describe("design skins model", () => {
  it("ships exactly the four named skins, default first", () => {
    expect([...SKIN_NAMES]).toEqual(["editorial", "studio", "workshop", "canvas"]);
    expect(DEFAULT_SKIN).toBe("editorial");
    expect(isSkinName("workshop")).toBe(true);
    expect(isSkinName("nope")).toBe(false);
  });

  it("editorial reproduces the brand accent family exactly (default is a no-op)", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const role of ACCENT_ROLE_ORDER) {
        expect(SKINS.editorial[theme][role]).toBe(BRAND_TOKENS[theme][role]);
      }
    }
  });

  it("carries no indigo-violet (hue 270–279) — the SaaS default we rejected", () => {
    for (const value of allSkinValues()) expect(value).not.toMatch(INDIGO);
  });

  it("keeps accent lightness in an AA-safe direction (light fill dark, dark fill light)", () => {
    for (const skin of SKIN_NAMES) {
      // Light theme: accent is a fill behind near-white accent-fg → keep it dark enough.
      expect(lightnessOf(SKINS[skin].light.accent)).toBeLessThanOrEqual(0.6);
      // Dark theme: accent is a fill behind near-ink accent-fg → keep it light enough.
      expect(lightnessOf(SKINS[skin].dark.accent)).toBeGreaterThanOrEqual(0.68);
    }
  });

  it("every skin defines the full accent family + a display bundle", () => {
    for (const skin of SKIN_NAMES) {
      const def = SKINS[skin];
      for (const theme of ["light", "dark"] as const) {
        for (const role of ACCENT_ROLE_ORDER) {
          expect(def[theme][role]).toMatch(/^oklch\(/);
        }
      }
      expect(def.display.family).toMatch(/serif|sans|mono|Geist|Newsreader/);
      expect(def.display.weight).toBeGreaterThanOrEqual(400);
      expect(def.radiusScale).toBeGreaterThan(0);
    }
  });

  it("generators emit the canonical custom-property lines", () => {
    const accent = skinAccentCssVars("studio", "light", "  ");
    expect(accent).toContain(`--accent: ${SKINS.studio.light.accent};`);
    expect(accent).toContain(`--ring: ${SKINS.studio.light.ring};`);

    const display = skinDisplayCssVars("canvas", "  ");
    expect(display).toContain(`--display-weight: ${SKINS.canvas.display.weight};`);
    expect(display).toContain(`--radius-scale: ${SKINS.canvas.radiusScale};`);

    const syn = syntaxCssVars("dark", "  ");
    expect(syn).toContain(`--syn-keyword: ${SYNTAX_TOKENS.dark["syn-keyword"]};`);
  });

  it("skinOverridesCss emits a block per non-default skin (server surfaces)", () => {
    const css = skinOverridesCss();
    // editorial is the base :root — no override block.
    expect(css).not.toContain('data-skin="editorial"');
    for (const skin of ["studio", "workshop", "canvas"] as const) {
      expect(css).toContain(`:root[data-skin="${skin}"] {`);
      expect(css).toContain(SKINS[skin].light.accent);
      // Dark accents live under the OS @media path by default (no theme toggle).
      expect(css).toContain(`:root[data-skin="${skin}"]:not([data-theme="light"])`);
      expect(css).toContain(SKINS[skin].dark.accent);
    }
    // No manual [data-theme="dark"] selector unless asked.
    expect(css).not.toContain('[data-theme="dark"]');
    expect(skinOverridesCss({ darkToggle: true })).toContain('[data-theme="dark"]');
  });
});
