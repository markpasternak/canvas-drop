/**
 * BRAND_TOKENS — the single canonical colour ramp for canvas-drop.
 *
 * This is the brand layer (§ token layering in DESIGN.md). Every surface — the
 * dashboard SPA (`apps/dashboard/src/styles/tokens.css`) and every server-rendered
 * page (landing, error, legal, docs, guest, social) — derives its colours from
 * THIS object. A parity test (`tokens.test.ts`) fails CI if any surface drifts.
 *
 * Re-skin the whole product by editing the values here (+ `brand.ts` for fonts /
 * name / logo). Authored in OKLCH for a perceptually even ramp and predictable
 * contrast; all pairings target WCAG 2.1 AA.
 *
 * Direction: "Editorial Creator OS" — warm-paper light (default) + graphite dark,
 * a single deep-teal accent (hue ~190). Amber (hue ~72) is a marketing-only second
 * accent and is NOT part of the app ramp.
 */

/** Every semantic colour role, per theme. Values are OKLCH strings. */
export interface RampTokens {
  canvas: string;
  surface: string;
  "surface-raised": string;
  "surface-sunken": string;
  "surface-hover": string;
  fg: string;
  muted: string;
  subtle: string;
  border: string;
  "border-strong": string;
  accent: string;
  "accent-hover": string;
  "accent-fg": string;
  "accent-subtle": string;
  danger: string;
  "danger-hover": string;
  "danger-fg": string;
  "danger-subtle": string;
  success: string;
  "success-subtle": string;
  warning: string;
  "warning-subtle": string;
  ring: string;
  "logo-frame": string;
  "logo-drop": string;
  scrim: string;
}

export interface BrandTokens {
  light: RampTokens;
  dark: RampTokens;
}

export const BRAND_TOKENS: BrandTokens = {
  // --- LIGHT: warm paper (default) ---
  light: {
    canvas: "oklch(0.972 0.004 85)",
    surface: "oklch(0.992 0.003 85)",
    "surface-raised": "oklch(0.998 0.002 85)",
    "surface-sunken": "oklch(0.943 0.006 85)",
    "surface-hover": "oklch(0.955 0.006 85)",
    fg: "oklch(0.250 0.009 75)",
    muted: "oklch(0.460 0.009 75)",
    subtle: "oklch(0.500 0.009 75)",
    border: "oklch(0.865 0.007 85)",
    "border-strong": "oklch(0.770 0.010 75)",

    accent: "oklch(0.48 0.085 190)",
    "accent-hover": "oklch(0.42 0.080 190)",
    "accent-fg": "oklch(0.99 0.005 190)",
    "accent-subtle": "oklch(0.935 0.025 190)",

    danger: "oklch(0.555 0.205 27)",
    "danger-hover": "oklch(0.49 0.2 27)",
    "danger-fg": "oklch(0.99 0.012 27)",
    "danger-subtle": "oklch(0.95 0.03 27)",

    success: "oklch(0.52 0.13 152)",
    "success-subtle": "oklch(0.95 0.04 152)",
    warning: "oklch(0.53 0.14 58)",
    "warning-subtle": "oklch(0.95 0.05 80)",

    ring: "oklch(0.48 0.085 190)",
    "logo-frame": "oklch(0.270 0.009 75)",
    "logo-drop": "oklch(0.48 0.085 190)",
    scrim: "oklch(0.21 0.02 80 / 0.5)",
  },

  // --- DARK: graphite ---
  dark: {
    canvas: "oklch(0.205 0.006 80)",
    surface: "oklch(0.240 0.006 80)",
    "surface-raised": "oklch(0.280 0.007 80)",
    "surface-sunken": "oklch(0.175 0.005 80)",
    "surface-hover": "oklch(0.290 0.008 80)",
    fg: "oklch(0.954 0.005 85)",
    muted: "oklch(0.740 0.008 85)",
    subtle: "oklch(0.670 0.008 85)",
    border: "oklch(0.350 0.008 80)",
    "border-strong": "oklch(0.440 0.010 80)",

    accent: "oklch(0.76 0.075 190)",
    "accent-hover": "oklch(0.81 0.070 190)",
    "accent-fg": "oklch(0.18 0.015 190)",
    "accent-subtle": "oklch(0.30 0.034 190)",

    danger: "oklch(0.7 0.17 25)",
    "danger-hover": "oklch(0.76 0.155 25)",
    "danger-fg": "oklch(0.16 0.03 25)",
    "danger-subtle": "oklch(0.28 0.08 22)",

    success: "oklch(0.78 0.16 155)",
    "success-subtle": "oklch(0.27 0.06 155)",
    warning: "oklch(0.82 0.15 80)",
    "warning-subtle": "oklch(0.27 0.06 70)",

    ring: "oklch(0.81 0.070 190)",
    "logo-frame": "oklch(0.954 0.005 85)",
    "logo-drop": "oklch(0.76 0.075 190)",
    scrim: "oklch(0.06 0.004 80 / 0.66)",
  },
};

/** Marketing-only second accent (warm amber). NOT part of the app ramp. */
export const MARKETING_ACCENT = {
  light: { amber: "oklch(0.78 0.15 72)", "amber-ink": "oklch(0.52 0.13 60)" },
  dark: { amber: "oklch(0.80 0.14 75)", "amber-ink": "oklch(0.80 0.14 75)" },
} as const;

export type ThemeName = keyof BrandTokens;

/** Order in which roles are emitted to CSS (stable for tests + diffs). */
export const RAMP_ROLE_ORDER = Object.keys(BRAND_TOKENS.light) as (keyof RampTokens)[];

/**
 * Emit the semantic CSS custom-property declarations for a theme, e.g.
 * `--canvas: oklch(...); --surface: oklch(...); …`. Server renderers and the
 * token-parity test consume this so no surface hand-inlines the ramp.
 */
export function rampCssVars(theme: ThemeName, indent = "  "): string {
  const ramp = BRAND_TOKENS[theme];
  return RAMP_ROLE_ORDER.map((role) => `${indent}--${role}: ${ramp[role]};`).join("\n");
}
