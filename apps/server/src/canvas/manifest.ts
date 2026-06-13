import type { Manifest } from "@canvas-drop/shared/db";

/**
 * The single HTML file in a manifest, or null when there are zero or several.
 *
 * Used in two places so a one-file deploy whose page isn't named `index.html`
 * still works: the serve resolver falls back to it at the canvas root, and the
 * deploy engine uses its absence to decide whether to warn about a rootless
 * deploy. "HTML" is decided by the manifest entry's MIME (`text/html…`).
 */
export function soleHtmlEntry(manifest: Manifest): string | null {
  const html = Object.keys(manifest).filter((p) => manifest[p]?.mime.startsWith("text/html"));
  return html.length === 1 ? (html[0] ?? null) : null;
}
