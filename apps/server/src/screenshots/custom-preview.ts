import { SCREENSHOT_RENDITIONS, screenshotKey } from "../canvas/storage-keys.js";
import type { StorageDriver } from "../storage/driver.js";

/**
 * Best-effort delete of a canvas's stored preview renditions (plan 004). Used when
 * clearing a custom cover or transitioning a canvas AWAY from `custom`, so leftover
 * owner-uploaded bytes can never be served as a stale cover (serve.ts would otherwise
 * hand them back under `auto`). Swallows per-rendition errors — a missing/already-gone
 * blob is fine; this is cosmetic cleanup, never a hard failure.
 */
export async function deletePreviewRenditions(
  storage: StorageDriver,
  canvasId: string,
): Promise<void> {
  for (const rendition of SCREENSHOT_RENDITIONS) {
    await storage.delete(screenshotKey(canvasId, rendition)).catch(() => {});
  }
}
