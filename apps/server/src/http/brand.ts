/**
 * The canvas-drop brand mark (drop-frame + download arrow + `</>` code), driven by
 * the `--logo-frame` / `--logo-drop` CSS vars so it adapts to light/dark. The mark
 * geometry lives once in `@canvas-drop/shared` (brand/logo.ts) — the dashboard
 * `<BrandMark>` mirrors the same paths — so a logo change is a single edit.
 */
import { brandMarkSvg } from "@canvas-drop/shared";

export const BRAND_MARK = brandMarkSvg({
  svgAttrs: 'class="mark"',
  frame: "var(--logo-frame)",
  drop: "var(--logo-drop)",
});
