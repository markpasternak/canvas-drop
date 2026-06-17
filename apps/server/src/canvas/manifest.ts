import type { Manifest } from "@canvas-drop/shared/db";
import type { VersionsRepository } from "../db/repositories/versions.js";

/**
 * The live (current + ready) version's number and manifest for a canvas, or null
 * when nothing is live (never deployed, or the pointer is at a non-ready version).
 *
 * The single read path behind both the MCP `get_canvas_file` tool and the keyed
 * Deploy API `GET …/files` read-back, so the two verification surfaces resolve the
 * same bytes a browser would get. (The asset-serving middleware keeps its own copy
 * because it also needs the version row for ETag/cache handling.)
 */
export async function liveManifest(
  versions: VersionsRepository,
  currentVersionId: string | null,
): Promise<{ number: number; manifest: Manifest } | null> {
  if (!currentVersionId) return null;
  const version = await versions.findById(currentVersionId);
  if (version?.status !== "ready" || !version.manifest) return null;
  return { number: version.number, manifest: version.manifest as Manifest };
}

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

/**
 * Whether two manifests have identical content: same path set and same content
 * hash for every path (size/mime are derived from the bytes, so the hash is the
 * authoritative equality key). The single comparator for "did these files change",
 * shared by the editor's dirty check (draft vs live) and the deploy engine's
 * post-publish draft reconciliation (draft vs its base version) so the two can't
 * drift apart.
 */
export function manifestsEqual(a: Manifest, b: Manifest): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const path of ak) {
    if (a[path]?.hash !== b[path]?.hash) return false;
  }
  return true;
}
