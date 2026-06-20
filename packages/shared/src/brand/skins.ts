/**
 * SKINS — the expression layer (DESIGN.md § token layering, "design skins").
 *
 * A skin is a *named, partial override* of the brand layer: the accent family, a
 * display-type bundle (font / weight / tracking), and a radius scale. It sits BETWEEN
 * the System layer (geometry — untouched) and the Brand layer (the one ramp). Today's
 * look is the default skin `editorial`; `studio` / `workshop` / `canvas` are alternate
 * design languages an admin can flip instance-wide (config `designSkin`).
 *
 * Token-only by rule (no structural layout forks): a skin changes accent, display
 * type, and radius over the SAME component structure. Syntax-highlight tokens are
 * theme-dependent but skin-independent (they live per-theme, shared across skins).
 *
 * This object is canonical. The hand-authored dashboard `tokens.css` and every
 * server-rendered surface derive their `[data-skin]` blocks from here; a parity test
 * (`tokens.test.ts`) fails CI if a surface drifts. Authored in OKLCH; accent lightness
 * is kept conservative so `accent-fg` (near-white/near-ink) clears WCAG AA on the fill.
 * No hue in 270–279 (the rejected indigo-violet band) — `canvas` is violet-magenta.
 */

import { BRAND } from "./brand.js";
import { BRAND_TOKENS, type ThemeName } from "./tokens.js";

export const SKIN_NAMES = ["editorial", "studio", "workshop", "canvas"] as const;
export type SkinName = (typeof SKIN_NAMES)[number];

/** The default skin — reproduces today's "Editorial Creator OS" exactly. */
export const DEFAULT_SKIN: SkinName = "editorial";

export function isSkinName(v: unknown): v is SkinName {
  return typeof v === "string" && (SKIN_NAMES as readonly string[]).includes(v);
}

/** The accent family a skin overrides, per theme. */
export interface AccentTokens {
  accent: string;
  "accent-hover": string;
  "accent-fg": string;
  "accent-subtle": string;
  ring: string;
}

/** Display-type bundle (headings/hero). Body sans + mono are never re-voiced. */
export interface DisplayTokens {
  /** `--font-display` family stack. */
  family: string;
  /** `--display-weight` (numeric font-weight). */
  weight: number;
  /** `--display-tracking` (letter-spacing). */
  tracking: string;
}

export interface SkinDef {
  label: string;
  description: string;
  display: DisplayTokens;
  /** `--radius-scale` multiplier (1 = the System radius geometry, unchanged). */
  radiusScale: number;
  /** `--shadow-strength` multiplier on the elevation alphas (1 = the System shadows;
   *  workshop flattens for an IDE feel, canvas deepens for a floaty/playful one). */
  shadowStrength: number;
  light: AccentTokens;
  dark: AccentTokens;
}

/** Stable emit/test order for the accent family. */
export const ACCENT_ROLE_ORDER = [
  "accent",
  "accent-hover",
  "accent-fg",
  "accent-subtle",
  "ring",
] as const satisfies readonly (keyof AccentTokens)[];

// Display font stacks — the SAME self-hosted stacks the brand layer already ships
// (no new fonts). Kept in lockstep with `tokens.css` --font-serif/sans/mono.
const SERIF = BRAND.fontSerif;
const SANS = BRAND.fontSans;
const MONO = BRAND.fontMono;

export const SKINS: Record<SkinName, SkinDef> = {
  // Default — identical to BRAND_TOKENS (the base :root needs no override block).
  editorial: {
    label: "Editorial",
    description: "The default — calm publishing OS: deep teal, editorial serif, soft paper.",
    display: { family: SERIF, weight: 500, tracking: "-0.02em" },
    radiusScale: 1,
    shadowStrength: 1,
    light: {
      accent: BRAND_TOKENS.light.accent,
      "accent-hover": BRAND_TOKENS.light["accent-hover"],
      "accent-fg": BRAND_TOKENS.light["accent-fg"],
      "accent-subtle": BRAND_TOKENS.light["accent-subtle"],
      ring: BRAND_TOKENS.light.ring,
    },
    dark: {
      accent: BRAND_TOKENS.dark.accent,
      "accent-hover": BRAND_TOKENS.dark["accent-hover"],
      "accent-fg": BRAND_TOKENS.dark["accent-fg"],
      "accent-subtle": BRAND_TOKENS.dark["accent-subtle"],
      ring: BRAND_TOKENS.dark.ring,
    },
  },

  // Warm editorial — same serif voice, terracotta accent (hue ~42).
  studio: {
    label: "Studio",
    description: "Warm editorial: terracotta accent over the same serif voice.",
    display: { family: SERIF, weight: 500, tracking: "-0.02em" },
    radiusScale: 1,
    shadowStrength: 1,
    light: {
      accent: "oklch(0.53 0.15 42)",
      "accent-hover": "oklch(0.47 0.145 42)",
      "accent-fg": "oklch(0.99 0.02 60)",
      "accent-subtle": "oklch(0.95 0.04 50)",
      ring: "oklch(0.53 0.15 42)",
    },
    dark: {
      accent: "oklch(0.72 0.13 48)",
      "accent-hover": "oklch(0.77 0.12 48)",
      "accent-fg": "oklch(0.18 0.04 50)",
      "accent-subtle": "oklch(0.32 0.07 45)",
      ring: "oklch(0.77 0.12 48)",
    },
  },

  // Developer / IDE — monospace display, green-teal accent (hue ~165), tighter radii.
  workshop: {
    label: "Workshop",
    description: "Developer/IDE feel: monospace display, green accent, tighter corners.",
    display: { family: MONO, weight: 500, tracking: "-0.01em" },
    radiusScale: 0.62,
    shadowStrength: 0.5,
    light: {
      accent: "oklch(0.5 0.12 165)",
      "accent-hover": "oklch(0.44 0.115 165)",
      "accent-fg": "oklch(0.99 0.02 165)",
      "accent-subtle": "oklch(0.95 0.045 168)",
      ring: "oklch(0.5 0.12 165)",
    },
    dark: {
      accent: "oklch(0.78 0.13 168)",
      "accent-hover": "oklch(0.82 0.12 168)",
      "accent-fg": "oklch(0.17 0.04 168)",
      "accent-subtle": "oklch(0.30 0.06 168)",
      ring: "oklch(0.82 0.12 168)",
    },
  },

  // Playful / bold — heavy sans display, violet-magenta accent (hue ~292), rounder.
  canvas: {
    label: "Canvas",
    description: "Playful and bold: heavy sans display, violet accent, rounder corners.",
    display: { family: SANS, weight: 800, tracking: "-0.035em" },
    radiusScale: 1.3,
    shadowStrength: 1.45,
    light: {
      accent: "oklch(0.52 0.2 292)",
      "accent-hover": "oklch(0.46 0.2 292)",
      "accent-fg": "oklch(0.99 0.012 292)",
      "accent-subtle": "oklch(0.93 0.06 295)",
      ring: "oklch(0.52 0.2 292)",
    },
    dark: {
      accent: "oklch(0.74 0.18 296)",
      "accent-hover": "oklch(0.79 0.16 296)",
      "accent-fg": "oklch(0.16 0.04 296)",
      "accent-subtle": "oklch(0.31 0.09 296)",
      ring: "oklch(0.79 0.16 296)",
    },
  },
};

/** Syntax-highlight tokens — theme-dependent, skin-independent (per the prototype). */
export interface SyntaxTokens {
  "syn-tag": string;
  "syn-attr": string;
  "syn-string": string;
  "syn-comment": string;
  "syn-keyword": string;
  "syn-fn": string;
  "syn-num": string;
  "syn-punc": string;
}

export const SYNTAX_ROLE_ORDER = [
  "syn-tag",
  "syn-attr",
  "syn-string",
  "syn-comment",
  "syn-keyword",
  "syn-fn",
  "syn-num",
  "syn-punc",
] as const satisfies readonly (keyof SyntaxTokens)[];

export const SYNTAX_TOKENS: Record<ThemeName, SyntaxTokens> = {
  light: {
    "syn-tag": "oklch(0.55 0.16 25)",
    "syn-attr": "oklch(0.56 0.12 65)",
    "syn-string": "oklch(0.52 0.11 150)",
    "syn-comment": "oklch(0.62 0.02 80)",
    "syn-keyword": "oklch(0.5 0.16 300)",
    "syn-fn": "oklch(0.5 0.14 250)",
    "syn-num": "oklch(0.55 0.13 45)",
    "syn-punc": "oklch(0.5 0.02 75)",
  },
  dark: {
    "syn-tag": "oklch(0.72 0.15 22)",
    "syn-attr": "oklch(0.82 0.12 72)",
    "syn-string": "oklch(0.8 0.12 152)",
    "syn-comment": "oklch(0.6 0.02 82)",
    "syn-keyword": "oklch(0.74 0.14 300)",
    "syn-fn": "oklch(0.74 0.12 250)",
    "syn-num": "oklch(0.78 0.12 52)",
    "syn-punc": "oklch(0.62 0.01 82)",
  },
};

/** Emit the accent-family CSS custom properties for a skin + theme. */
export function skinAccentCssVars(skin: SkinName, theme: ThemeName, indent = "  "): string {
  const ramp = SKINS[skin][theme];
  return ACCENT_ROLE_ORDER.map((role) => `${indent}--${role}: ${ramp[role]};`).join("\n");
}

/** Emit the display-bundle + radius-scale CSS custom properties for a skin. */
export function skinDisplayCssVars(skin: SkinName, indent = "  "): string {
  const d = SKINS[skin];
  return [
    `${indent}--font-display: ${d.display.family};`,
    `${indent}--display-weight: ${d.display.weight};`,
    `${indent}--display-tracking: ${d.display.tracking};`,
    `${indent}--radius-scale: ${d.radiusScale};`,
    `${indent}--shadow-strength: ${d.shadowStrength};`,
  ].join("\n");
}

/** Emit the syntax-highlight CSS custom properties for a theme. */
export function syntaxCssVars(theme: ThemeName, indent = "  "): string {
  const syn = SYNTAX_TOKENS[theme];
  return SYNTAX_ROLE_ORDER.map((role) => `${indent}--${role}: ${syn[role]};`).join("\n");
}

/**
 * Emit the full `[data-skin]` override CSS for every non-default skin — accent family
 * + display bundle (light) and the accent family under the dark path(s). The default
 * skin (editorial) is the base `:root`, so it gets no block. Server-rendered surfaces
 * (landing, etc.) inject this so they re-skin from the SAME source as the dashboard's
 * hand-authored tokens.css. `darkToggle` adds the manual `[data-theme="dark"]` selector
 * (surfaces with a theme toggle); OS-only surfaces (the landing) leave it off.
 */
export function skinOverridesCss(opts: { darkToggle?: boolean } = {}): string {
  const { darkToggle = false } = opts;
  const blocks: string[] = [];
  for (const skin of SKIN_NAMES) {
    if (skin === DEFAULT_SKIN) continue;
    blocks.push(
      `:root[data-skin="${skin}"] {\n${skinAccentCssVars(skin, "light")}\n${skinDisplayCssVars(skin)}\n}`,
    );
    blocks.push(
      `@media (prefers-color-scheme: dark) {\n  :root[data-skin="${skin}"]:not([data-theme="light"]) {\n${skinAccentCssVars(skin, "dark", "    ")}\n  }\n}`,
    );
    if (darkToggle) {
      blocks.push(
        `:root[data-skin="${skin}"][data-theme="dark"] {\n${skinAccentCssVars(skin, "dark")}\n}`,
      );
    }
  }
  return blocks.join("\n");
}
