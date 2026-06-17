import type { ScreenshotsRepository } from "../db/repositories/screenshots.js";

/**
 * Shared deps for the cosmetic preview-existence hint (plan 004). Both fields are
 * optional: when either is absent the pipeline is treated as OFF (no previews), so a
 * surface that doesn't wire screenshots behaves exactly like today. `screenshotsEnabled`
 * is the effective gate (env-available AND admin-enabled); `screenshots.doneCanvasIds`
 * is the batched captured-preview lookup.
 */
export interface PreviewHintDeps {
  screenshotsEnabled?: () => Promise<boolean>;
  screenshots?: Pick<ScreenshotsRepository, "doneCanvasIds">;
}

/**
 * Of the given canvas ids, those with a captured (`done`) preview — empty when the
 * screenshot pipeline is off (so `hasPreview` is false and every surface behaves like
 * today). The hint is COSMETIC, so any failure — the settings read or the batched
 * `doneCanvasIds` lookup throwing — degrades to "no preview" rather than erroring the
 * primary canvas/gallery/MCP response (a screenshot-subsystem hiccup must never 500 the
 * surfaces that merely decorate themselves with a cover).
 *
 * Single source of truth shared by the management routes, the gallery route, and the
 * MCP tool server so the gate + degrade semantics can't drift between them.
 */
export async function resolvePreviewIds(
  deps: PreviewHintDeps,
  canvasIds: string[],
): Promise<Set<string>> {
  if (!deps.screenshots || !deps.screenshotsEnabled) return new Set();
  try {
    if (!(await deps.screenshotsEnabled())) return new Set();
    return new Set(await deps.screenshots.doneCanvasIds(canvasIds));
  } catch {
    return new Set();
  }
}
