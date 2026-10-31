import type { Canvas } from "@canvas-drop/shared/db";
import { SCREENSHOT_RENDITIONS, screenshotKey } from "../canvas/storage-keys.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { StorageDriver } from "../storage/driver.js";
import { previewVisible } from "./preview-ids.js";

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

/**
 * Keep the canvas's current automatic screenshot as its custom cover ("burn it in").
 * Screenshots and uploaded covers live under the same rendition keys, so nothing is
 * copied: flipping `previewMode` to `custom` pins the stored renditions exactly as an
 * upload would. From then on a publish never re-captures over it, it is served while the
 * screenshot pipeline is off, and it counts as the owner-approved cover for link
 * previews (an automatic screenshot never does).
 *
 * Only a screenshot the owner can actually see qualifies: `auto` mode with a captured
 * (`done`) preview under the effective pipeline gate (`previewVisible`), and the `og`
 * rendition present in storage. A canvas already on `custom` is left as it is
 * (idempotent). Shared by the management route and the MCP tool. The caller audits.
 */
export async function keepScreenshotAsCover(
  deps: {
    storage: Pick<StorageDriver, "exists">;
    canvases: Pick<CanvasesRepository, "updateSettings">;
    previewIds: (canvasIds: string[]) => Promise<Set<string>>;
  },
  cv: Canvas,
): Promise<
  { ok: true; canvas: Canvas; changed: boolean } | { ok: false; code: string; message: string }
> {
  if (cv.previewMode === "custom") return { ok: true, canvas: cv, changed: false };
  const noShot = {
    ok: false as const,
    code: "NO_SCREENSHOT",
    message: "this canvas has no automatic screenshot to keep",
  };
  if (cv.previewMode !== "auto") return noShot;
  if (!previewVisible(cv, await deps.previewIds([cv.id]))) return noShot;
  if (!(await deps.storage.exists(screenshotKey(cv.id, "og")).catch(() => false))) return noShot;
  const canvas = await deps.canvases.updateSettings(cv.id, { previewMode: "custom" });
  return { ok: true, canvas, changed: true };
}
