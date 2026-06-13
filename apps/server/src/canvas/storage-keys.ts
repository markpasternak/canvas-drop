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
