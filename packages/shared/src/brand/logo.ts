/**
 * The canvas-drop mark — a rounded "drop-frame" with a bold download arrow
 * dropping in through the top and `</>` filling the body (drop a web tool in).
 *
 * One source of path-data (geometry from the approved working mark). Colours come
 * from `--logo-frame` (frame) and `--logo-drop` (arrow + code) so the mark adapts
 * to light/dark/accent contexts. Consumed by the server-rendered pages here and
 * mirrored by the dashboard `<BrandMark>` (which inlines the same paths for
 * bundle-safety). Wordmark is set in Geist as HTML alongside the mark, never in SVG.
 */

/** viewBox tightly bounding the mark. */
export const LOGO_VIEWBOX = "158 209 372 432";

/** Each path with its own stroke width (the arrow is heavier than the code). */
export const LOGO_PATHS = {
  frame: {
    d: "M245 335H218C191.49 335 170 356.49 170 383V581C170 607.51 191.49 629 218 629H470C496.51 629 518 607.51 518 581V383C518 356.49 496.51 335 470 335H443",
    width: 24,
  },
  /** arrow (shaft + head) + code </> (left chevron, right chevron, slash) */
  drop: [
    { d: "M344 222V392", width: 27 },
    { d: "M291 349L344 402L397 349", width: 27 },
    { d: "M286 462L241 507L286 552", width: 25 },
    { d: "M402 462L447 507L402 552", width: 25 },
    { d: "M366 452L326 566", width: 20 },
  ],
} as const;

export interface MarkOptions {
  /** extra attributes for the <svg> (e.g. class="mark") */
  svgAttrs?: string;
  /** stroke colour for the frame */
  frame?: string;
  /** stroke colour for the arrow + code */
  drop?: string;
}

/** Render the mark as an SVG string (for server-rendered pages). */
export function brandMarkSvg(opts: MarkOptions = {}): string {
  const frame = opts.frame ?? "var(--logo-frame, currentColor)";
  const drop = opts.drop ?? "var(--logo-drop, currentColor)";
  const cap = `stroke-linecap="round" stroke-linejoin="round"`;
  const dropPaths = LOGO_PATHS.drop
    .map((p) => `  <path d="${p.d}" stroke="${drop}" stroke-width="${p.width}" ${cap}/>`)
    .join("\n");
  return `<svg viewBox="${LOGO_VIEWBOX}" fill="none" aria-hidden="true"${opts.svgAttrs ? ` ${opts.svgAttrs}` : ""}>
  <path d="${LOGO_PATHS.frame.d}" stroke="${frame}" stroke-width="${LOGO_PATHS.frame.width}" ${cap}/>
${dropPaths}
</svg>`;
}
