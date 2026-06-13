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

/**
 * What a deploy serves at the canvas root, classified for display:
 *   - `index`     → an index.html (the normal case)
 *   - `single`    → no index.html, but one HTML file, which is served at the root
 *   - `ambiguous` → no index.html and several HTML files → root 404s (can't pick)
 *   - `none`      → no HTML at all → root 404s
 * Mirrors the serve resolver's root resolution (both use {@link soleHtmlEntry}).
 */
export type RootEntry =
  | { path: string; reason: "index" | "single" }
  | { path: null; reason: "ambiguous" | "none" };

export function rootEntry(manifest: Manifest): RootEntry {
  if (manifest["index.html"]) return { path: "index.html", reason: "index" };
  const sole = soleHtmlEntry(manifest);
  if (sole) return { path: sole, reason: "single" };
  const htmlCount = Object.keys(manifest).filter((p) =>
    manifest[p]?.mime.startsWith("text/html"),
  ).length;
  return { path: null, reason: htmlCount > 1 ? "ambiguous" : "none" };
}
