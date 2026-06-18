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
 * Direction: "Editorial Creator OS" — warm-paper light (default) + deep-navy dark,
 * a single deep-teal accent (hue ~200). Amber (hue ~72) is a marketing-only second
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
    canvas: "oklch(0.969 0.008 85)",
    surface: "oklch(0.987 0.006 85)",
    "surface-raised": "oklch(0.998 0.004 85)",
    "surface-sunken": "oklch(0.945 0.010 85)",
    "surface-hover": "oklch(0.955 0.010 85)",
    fg: "oklch(0.255 0.012 75)",
    muted: "oklch(0.475 0.012 75)",
    subtle: "oklch(0.500 0.012 75)",
    border: "oklch(0.895 0.010 85)",
    "border-strong": "oklch(0.820 0.012 75)",

    accent: "oklch(0.49 0.105 200)",
    "accent-hover": "oklch(0.43 0.10 200)",
    "accent-fg": "oklch(0.99 0.02 200)",
    "accent-subtle": "oklch(0.93 0.045 197)",

    danger: "oklch(0.555 0.205 27)",
    "danger-hover": "oklch(0.49 0.2 27)",
    "danger-fg": "oklch(0.99 0.012 27)",
    "danger-subtle": "oklch(0.95 0.03 27)",

    success: "oklch(0.52 0.13 152)",
    "success-subtle": "oklch(0.95 0.04 152)",
    warning: "oklch(0.53 0.14 58)",
    "warning-subtle": "oklch(0.95 0.05 80)",

    ring: "oklch(0.49 0.105 200)",
    "logo-frame": "oklch(0.27 0.022 235)",
    "logo-drop": "oklch(0.49 0.105 200)",
    scrim: "oklch(0.21 0.02 80 / 0.5)",
  },

  // --- DARK: deep navy ---
  dark: {
    canvas: "oklch(0.175 0.018 265)",
    surface: "oklch(0.212 0.020 265)",
    "surface-raised": "oklch(0.245 0.022 265)",
    "surface-sunken": "oklch(0.150 0.016 265)",
    "surface-hover": "oklch(0.262 0.022 265)",
    fg: "oklch(0.965 0.004 265)",
    muted: "oklch(0.715 0.014 265)",
    subtle: "oklch(0.620 0.014 265)",
    border: "oklch(0.295 0.020 265)",
    "border-strong": "oklch(0.390 0.022 265)",

    accent: "oklch(0.78 0.105 195)",
    "accent-hover": "oklch(0.83 0.09 195)",
    "accent-fg": "oklch(0.16 0.04 210)",
    "accent-subtle": "oklch(0.30 0.06 200)",

    danger: "oklch(0.7 0.17 25)",
    "danger-hover": "oklch(0.76 0.155 25)",
    "danger-fg": "oklch(0.16 0.03 25)",
    "danger-subtle": "oklch(0.28 0.08 22)",

    success: "oklch(0.78 0.16 155)",
    "success-subtle": "oklch(0.27 0.06 155)",
    warning: "oklch(0.82 0.15 80)",
    "warning-subtle": "oklch(0.27 0.06 70)",

    ring: "oklch(0.83 0.09 195)",
    "logo-frame": "oklch(0.965 0.004 265)",
    "logo-drop": "oklch(0.78 0.105 195)",
    scrim: "oklch(0.04 0.01 266 / 0.66)",
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
