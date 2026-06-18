/**
 * BRAND — product identity in one place (name, wordmark, fonts, accent, meta).
 *
 * The brand layer (with `BRAND_TOKENS` in `tokens.ts` and the mark in `logo.ts`).
 * A self-hoster re-brands in two files: edit `brand.ts` for the name/domain/fonts
 * and `tokens.ts` for the colors/logo. Org-agnostic by rule — no organisation-
 * specific naming lives in components.
 */
export const BRAND = {
  /** Product name. Lowercase wordmark; referenced everywhere instead of a literal. */
  name: "canvas-drop",
  /** Default public domain (a self-hoster overrides). */
  domain: "canvas-drop.com",
  /** Open-source project URL. */
  githubUrl: "https://github.com/markpasternak/canvas-drop",

  /** Primary accent hue (OKLCH) — deep teal. The single chromatic identity. */
  accentHue: 200,

  /** Browser/PWA theme-color (warm paper). */
  themeColor: "#f7f4ed",

  /** Type system (self-hosted via @fontsource-variable). Three voices. */
  fontSerif: '"Newsreader Variable", Georgia, "Times New Roman", serif',
  fontSans: '"Geist Variable", ui-sans-serif, system-ui, -apple-system, sans-serif',
  fontMono: '"Geist Mono Variable", ui-monospace, "SF Mono", Menlo, monospace',
} as const;

export type Brand = typeof BRAND;
