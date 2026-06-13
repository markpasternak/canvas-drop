import type { Config } from "@canvas-drop/shared";
import type { Manifest } from "@canvas-drop/shared/db";
import { rootEntry } from "./manifest.js";

/**
 * Pure request→manifest-entry resolution, shared by published-canvas serving
 * (serve.ts) and owner-only draft preview (draft-api.ts). Kept dependency-free so
 * the full resolution table stays unit-testable in one place.
 */

/** Extract the asset path (after the slug) from the request path. */
export function assetPathFor(config: Config, slug: string, reqPath: string): string {
  let p = reqPath;
  if (config.urlMode === "path") {
    const prefix = `/c/${slug}`;
    p = p.startsWith(prefix) ? p.slice(prefix.length) : p;
  }
  p = p.replace(/^\/+/, ""); // strip leading slash
  return p;
}

/**
 * Resolve a request to a manifest entry path: exact hit → directory index →
 * root entry → SPA fallback → null.
 *
 * The canvas "root entry" is index.html, or — forgiving a one-file deploy whose
 * page isn't named index.html — the single HTML file ({@link rootEntry}). The
 * root request and the SPA fallback both resolve to that SAME entry, so a
 * single-page app with a non-index entry works at the root AND for deep client
 * routes when SPA fallback is on. With several HTML files and no index, the entry
 * is undefined and both 404 (there's no way to pick the home page).
 */
export function resolveAsset(
  manifest: Manifest,
  assetPath: string,
  spaFallback: boolean,
): { path: string } | null {
  // Exact file hit (non-root).
  if (assetPath !== "" && manifest[assetPath]) return { path: assetPath };
  // Directory request → its own index.html.
  if (assetPath !== "") {
    const dirIndex = `${assetPath.replace(/\/$/, "")}/index.html`;
    if (manifest[dirIndex]) return { path: dirIndex };
  }
  const entry = rootEntry(manifest).path;
  // Root → the entry.
  if (assetPath === "" && entry) return { path: entry };
  // SPA fallback → the entry for any unmatched path (client-side routing).
  if (spaFallback && entry) return { path: entry };
  return null;
}
