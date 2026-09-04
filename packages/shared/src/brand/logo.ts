/**
 * The canvas-drop mark — a rounded "drop-frame" with a bold download arrow
 * dropping in through the top and `</>` filling the body (drop a web tool in).
 *
 * Square 32-unit construction, with optical weights for frame, arrow and code. Colours come
 * from `--logo-frame` (frame) and `--logo-drop` (arrow + code) so the mark adapts
 * to light/dark/accent contexts. Consumed by the server-rendered pages here and
 * mirrored by the dashboard `<BrandMark>` (which inlines the same paths for
 * bundle-safety). Wordmark is set in Geist as HTML alongside the mark, never in SVG.
 */

/** Stable square bounds for app chrome, downloadable artwork and favicons. */
export const LOGO_VIEWBOX = "0 0 32 32";

/** Each path with its own stroke width (the arrow is heavier than the code). */
export const LOGO_PATHS = {
  frame: {
    d: "M9 10H7a3 3 0 0 0-3 3v13a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3V13a3 3 0 0 0-3-3h-2",
    width: 2,
  },
  /** arrow (shaft + head) + code </> (left chevron, right chevron, slash) */
  drop: [
    { d: "M16 2v12m-5-5 5 5 5-5", width: 2.5 },
    { d: "M11 20l-3 3 3 3m10-6 3 3-3 3m-3-7-4 8", width: 1.75 },
  ],
} as const;

export interface MarkOptions {
  /** extra attributes for the <svg> (e.g. class="mark") */
  svgAttrs?: string;
  /** stroke colour for the frame */
  frame?: string;
  /** stroke colour for the arrow + code */
  drop?: string;
  /** Below 24px, keep the distinctive outer silhouette without crowded code. */
  compact?: boolean;
}

/** Render the mark as an SVG string (for server-rendered pages). */
export function brandMarkSvg(opts: MarkOptions = {}): string {
  const frame = opts.frame ?? "var(--logo-frame, currentColor)";
  const drop = opts.drop ?? "var(--logo-drop, currentColor)";
  const cap = `stroke-linecap="round" stroke-linejoin="round"`;
  const dropPaths = (opts.compact ? LOGO_PATHS.drop.slice(0, 1) : LOGO_PATHS.drop)
    .map((p) => `  <path d="${p.d}" stroke="${drop}" stroke-width="${p.width}" ${cap}/>`)
    .join("\n");
  return `<svg viewBox="${LOGO_VIEWBOX}" fill="none" aria-hidden="true"${opts.svgAttrs ? ` ${opts.svgAttrs}` : ""}>
  <path d="${LOGO_PATHS.frame.d}" stroke="${frame}" stroke-width="${LOGO_PATHS.frame.width}" ${cap}/>
${dropPaths}
</svg>`;
}
