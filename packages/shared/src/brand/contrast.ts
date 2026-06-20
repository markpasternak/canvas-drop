/**
 * WCAG contrast for OKLCH colours — the AA guard for the brand ramp + every design
 * skin. Authoring in OKLCH gives a perceptually even ramp but NOT a contrast guarantee,
 * so a test computes real ratios (OKLCH → linear sRGB → WCAG relative luminance) and
 * fails CI if any accent pairing a skin introduces drops below AA. Turns "tuned by eye"
 * into "guaranteed by CI", the same way the token-parity test guards drift.
 */

/** Parse the L, C, H out of an `oklch(L C H)` / `oklch(L C H / a)` string. */
function parseOklch(s: string): { L: number; C: number; H: number } {
  const m = s.match(/oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/i);
  if (!m) throw new Error(`not an oklch() colour: ${s}`);
  return { L: Number(m[1]), C: Number(m[2]), H: Number(m[3]) };
}

/** OKLCH → linear-light sRGB (clamped to gamut). WCAG luminance is defined on these
 *  linear values, so no sRGB gamma step is needed before the luminance dot product. */
function oklchToLinearRgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v))) as [number, number, number];
}

/** WCAG 2.1 relative luminance (on linear-light sRGB). */
function relativeLuminance(oklch: string): number {
  const { L, C, H } = parseOklch(oklch);
  const [r, g, b] = oklchToLinearRgb(L, C, H);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio between two OKLCH colours (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG thresholds: AA body text ≥ 4.5:1; AA large/UI ≥ 3:1. */
export const AA_TEXT = 4.5;
export const AA_LARGE = 3;
