/**
 * Storage key layout for canvas file bytes (M5, KTD-1). Files are stored
 * **content-addressed**: each distinct file's bytes live once under a per-canvas
 * blob namespace, keyed by its sha256. A version (and the draft) is a *manifest*
 * mapping path → hash, so identical content across versions/drafts is stored
 * once. Blobs are namespaced per canvas — dedup is within a canvas, refcount/GC
 * is canvas-scoped, and purge deletes the whole prefix in one call.
 *
 * Shared by the deploy engine (writes blobs), serving + preview (read by hash),
 * blob GC (mark-sweep over the prefix), and purge.
 */

/** Prefix holding every blob for a canvas: `canvases/{canvasId}/blobs/`. */
export function canvasBlobPrefix(canvasId: string): string {
  return `canvases/${canvasId}/blobs/`;
}

/** Storage key for one blob: the canvas blob prefix + the content hash (flat). */
export function blobKey(canvasId: string, hash: string): string {
  return canvasBlobPrefix(canvasId) + hash;
}

/** Recover the blob hash from a full key under {@link canvasBlobPrefix}. */
export function hashFromBlobKey(canvasId: string, key: string): string {
  return key.slice(canvasBlobPrefix(canvasId).length);
}

/**
 * Screenshot renditions (plan 004, KTD-6). A canvas has exactly ONE preview set,
 * stored at **canvas-stable** keys and **overwritten** on each publish — no
 * per-version history. Which version the current preview reflects is recorded on
 * the one-per-canvas `screenshot_jobs` row (its `versionId`), used to cache-bust
 * the cover URL. Deliberately **outside** {@link canvasBlobPrefix} so the content
 * blob GC never touches it; reclaim is by overwrite (republish) + delete-cleanup.
 */
export type ScreenshotRendition = "og" | "card" | "thumb";

export const SCREENSHOT_RENDITIONS: readonly ScreenshotRendition[] = ["og", "card", "thumb"];

/** Prefix holding a canvas's preview renditions: `screenshots/{canvasId}/`. */
export function screenshotPrefix(canvasId: string): string {
  return `screenshots/${canvasId}/`;
}

/** Canvas-stable storage key for one rendition: `screenshots/{canvasId}/{rendition}.webp`. */
export function screenshotKey(canvasId: string, rendition: ScreenshotRendition): string {
  return `${screenshotPrefix(canvasId)}${rendition}.webp`;
}
